/**
 * A small parser for the mongosh subset the MongoDB query console accepts:
 *
 *   db.users.find({ age: { $gt: 30 } }, { name: 1 }).sort({ name: 1 }).limit(10)
 *   db.getCollection("audit-log").countDocuments({})
 *   db.runCommand({ dbStats: 1 })
 *
 * Arguments are JavaScript-style literals (unquoted keys, single quotes,
 * trailing commas, comments) plus the shell helpers ObjectId(), ISODate(),
 * Date(), NumberInt(), NumberLong(), NumberDecimal() and /regex/flags.
 * Nothing is evaluated: anything else is a parse error.
 */

export class ShellParseError extends Error {
  constructor(message: string, public offset: number, public end = offset + 1) {
    super(message);
    this.name = "ShellParseError";
  }
}

export interface ShellCall {
  name: string;
  args: unknown[];
  from: number;
}

export interface ShellCommand {
  /** null for database-level methods (db.runCommand, db.getCollectionNames…). */
  collection: string | null;
  method: string;
  args: unknown[];
  /** Cursor modifiers after the main call: .sort(), .limit(), .skip(), .project()… */
  chain: ShellCall[];
  from: number;
  to: number;
}

/** BSON constructors from the project's own `mongodb` package (instanceof checks must match). */
export interface BsonFactory {
  objectId(hex: string): unknown;
  decimal(text: string): unknown;
  long(text: string): unknown;
}

const IDENT = /[A-Za-z_$][\w$]*/y;

class Parser {
  i = 0;
  constructor(private readonly src: string, private readonly bson: BsonFactory) {}

  fail(message: string, at = this.i, end?: number): never {
    throw new ShellParseError(message, at, end ?? Math.min(this.src.length, at + 1));
  }

  ws() {
    for (;;) {
      const ch = this.src[this.i];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") this.i++;
      else if (ch === "/" && this.src[this.i + 1] === "/") {
        const nl = this.src.indexOf("\n", this.i);
        this.i = nl < 0 ? this.src.length : nl + 1;
      } else if (ch === "/" && this.src[this.i + 1] === "*") {
        const end = this.src.indexOf("*/", this.i + 2);
        if (end < 0) this.fail("Unterminated comment");
        this.i = end + 2;
      } else return;
    }
  }

  peek() {
    this.ws();
    return this.src[this.i];
  }

  eat(ch: string) {
    if (this.peek() !== ch) this.fail(`Expected "${ch}"`);
    this.i++;
  }

  ident(): string {
    this.ws();
    IDENT.lastIndex = this.i;
    const m = IDENT.exec(this.src);
    if (!m) this.fail("Expected a name");
    this.i += m[0].length;
    return m[0];
  }

  atEnd() {
    return this.peek() === undefined;
  }

  /* ---------- commands ---------- */

  script(): ShellCommand[] {
    const out: ShellCommand[] = [];
    while (!this.atEnd()) {
      if (this.peek() === ";") {
        this.i++;
        continue;
      }
      out.push(this.command());
      const next = this.peek();
      if (next !== undefined && next !== ";" && next !== "d") this.fail('Expected ";" or the end of the command');
    }
    return out;
  }

  command(): ShellCommand {
    this.ws();
    const from = this.i;
    if (this.ident() !== "db") this.fail('Commands start with "db." (e.g. db.users.find({}))', from, this.i);
    let collection: string | null = null;
    let method: string;
    let args: unknown[];
    if (this.peek() === "[") {
      this.i++;
      collection = this.stringValue();
      this.eat("]");
    } else {
      this.eat(".");
      const at = this.i;
      const name = this.ident();
      if (this.peek() === "(") {
        args = this.args();
        if (name === "getCollection") {
          if (typeof args[0] !== "string" || args.length !== 1) this.fail("getCollection takes one collection name", at);
          collection = args[0];
        } else {
          return { collection: null, method: name, args, chain: [], from, to: this.i };
        }
      } else collection = name;
    }
    this.eat(".");
    method = this.ident();
    if (this.peek() !== "(") this.fail(`Call the method: ${method}(…)`);
    args = this.args();
    const chain: ShellCall[] = [];
    while (this.peek() === ".") {
      this.i++;
      const at = this.i;
      const name = this.ident();
      chain.push({ name, args: this.args(), from: at });
    }
    return { collection, method, args, chain, from, to: this.i };
  }

  args(): unknown[] {
    this.eat("(");
    const out: unknown[] = [];
    while (this.peek() !== ")") {
      out.push(this.value());
      if (this.peek() === ",") this.i++;
      else if (this.peek() !== ")") this.fail('Expected "," or ")"');
    }
    this.i++;
    return out;
  }

  /* ---------- values ---------- */

  value(): unknown {
    const ch = this.peek();
    if (ch === "{") return this.object();
    if (ch === "[") return this.array();
    if (ch === '"' || ch === "'") return this.stringValue();
    if (ch === "/") return this.regex();
    if (ch === "-" || ch === "+" || ch === "." || (ch >= "0" && ch <= "9")) return this.number();
    if (ch === undefined) this.fail("Unexpected end of input");
    const at = this.i;
    let name = this.ident();
    if (name === "new") name = this.ident();
    switch (name) {
      case "true":
        return true;
      case "false":
        return false;
      case "null":
      case "undefined":
        return null;
      case "Infinity":
        return Infinity;
      case "NaN":
        return NaN;
      case "ObjectId": {
        const [hex] = this.args();
        if (hex === undefined) return this.bson.objectId("");
        if (typeof hex !== "string" || !/^[0-9a-f]{24}$/i.test(hex)) this.fail("ObjectId takes a 24-character hex string", at, this.i);
        return this.bson.objectId(hex);
      }
      case "ISODate":
      case "Date": {
        const a = this.args();
        const d = a.length ? new Date(a[0] as string | number) : new Date();
        if (Number.isNaN(d.getTime())) this.fail("Invalid date", at, this.i);
        return d;
      }
      case "NumberInt":
      case "NumberLong":
      case "NumberDecimal": {
        const [v] = this.args();
        const text = String(v ?? "0");
        if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) this.fail(`${name} takes a number`, at, this.i);
        if (name === "NumberInt") return Number.parseInt(text, 10);
        return name === "NumberLong" ? this.bson.long(text) : this.bson.decimal(text);
      }
      default:
        this.fail(`Unknown value "${name}"`, at, this.i);
    }
  }

  object(): Record<string, unknown> {
    this.eat("{");
    const out: Record<string, unknown> = {};
    while (this.peek() !== "}") {
      const ch = this.peek();
      let key: string;
      if (ch === '"' || ch === "'") key = this.stringValue();
      else if (ch !== undefined && ch >= "0" && ch <= "9") key = String(this.number());
      else key = this.ident();
      this.eat(":");
      Object.defineProperty(out, key, { value: this.value(), enumerable: true, writable: true, configurable: true });
      if (this.peek() === ",") this.i++;
      else if (this.peek() !== "}") this.fail('Expected "," or "}"');
    }
    this.i++;
    return out;
  }

  array(): unknown[] {
    this.eat("[");
    const out: unknown[] = [];
    while (this.peek() !== "]") {
      out.push(this.value());
      if (this.peek() === ",") this.i++;
      else if (this.peek() !== "]") this.fail('Expected "," or "]"');
    }
    this.i++;
    return out;
  }

  stringValue(): string {
    this.ws();
    const quote = this.src[this.i];
    if (quote !== '"' && quote !== "'") this.fail("Expected a string");
    const start = this.i;
    let out = "";
    this.i++;
    for (;;) {
      const ch = this.src[this.i];
      if (ch === undefined || ch === "\n") this.fail("Unterminated string", start, this.i);
      if (ch === quote) {
        this.i++;
        return out;
      }
      if (ch === "\\") {
        const n = this.src[this.i + 1];
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "0": "\0" };
        if (n === "u") {
          const hex = this.src.slice(this.i + 2, this.i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("Invalid \\u escape");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.i += 6;
        } else {
          out += map[n] ?? n;
          this.i += 2;
        }
      } else {
        out += ch;
        this.i++;
      }
    }
  }

  number(): number {
    this.ws();
    const m = /[+-]?(Infinity|0x[0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/y;
    m.lastIndex = this.i;
    const r = m.exec(this.src);
    if (!r) this.fail("Expected a number");
    this.i += r[0].length;
    return Number(r[0]);
  }

  regex(): RegExp {
    const start = this.i;
    this.i++;
    let body = "";
    let inClass = false;
    for (;;) {
      const ch = this.src[this.i];
      if (ch === undefined || ch === "\n") this.fail("Unterminated regular expression", start, this.i);
      if (ch === "\\") {
        body += ch + (this.src[this.i + 1] ?? "");
        this.i += 2;
        continue;
      }
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) break;
      body += ch;
      this.i++;
    }
    this.i++;
    const flags = /[a-z]*/y;
    flags.lastIndex = this.i;
    const f = flags.exec(this.src)![0];
    this.i += f.length;
    try {
      return new RegExp(body, f);
    } catch (e) {
      this.fail((e as Error).message, start, this.i);
    }
  }
}

export function parseShell(src: string, bson: BsonFactory): ShellCommand[] {
  return new Parser(src, bson).script();
}

/** Parse a single literal value, e.g. a JSON-ish filter document typed into the filter bar. */
export function parseShellValue(src: string, bson: BsonFactory): unknown {
  const p = new Parser(src, bson);
  const v = p.value();
  if (!p.atEnd()) p.fail("Unexpected text after the value");
  return v;
}

/* ---------- printing (for the Console view and "copy as shell") ---------- */

export function shellStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return `ISODate(${JSON.stringify(Number.isNaN(value.getTime()) ? "invalid" : value.toISOString())})`;
  if (value instanceof RegExp) return String(value);
  if (Array.isArray(value)) return `[${value.map(shellStringify).join(", ")}]`;
  if (typeof value === "object") {
    const bsonType = (value as { _bsontype?: string })._bsontype;
    if (bsonType === "ObjectId" || bsonType === "ObjectID") return `ObjectId(${JSON.stringify(String((value as { toHexString(): string }).toHexString()))})`;
    if (bsonType === "Decimal128") return `NumberDecimal(${JSON.stringify(String(value))})`;
    if (bsonType === "Long") return `NumberLong(${JSON.stringify(String(value))})`;
    if (Buffer.isBuffer(value)) return `BinData(0, ${JSON.stringify(value.toString("base64"))})`;
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return "{}";
    return `{ ${entries.map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${shellStringify(v)}`).join(", ")} }`;
  }
  if (typeof value === "bigint") return `NumberLong(${JSON.stringify(value.toString())})`;
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

export function shellCollection(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? `db.${name}` : `db.getCollection(${JSON.stringify(name)})`;
}
