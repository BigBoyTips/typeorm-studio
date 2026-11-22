import type { DataSource, EntityMetadata, ObjectLiteral } from "typeorm";
import type { ColumnMetadata } from "typeorm/metadata/ColumnMetadata";
import {
  FILTER_OPERATORS,
  MAX_PAGE_SIZE,
  SEARCH_TIMEOUT_MESSAGE,
  SEARCH_TIMEOUT_MS,
  StudioError,
  stringifyDefault,
  typeGroup,
  typeName,
} from "./adapter";
import { logStudioOperation } from "./insights";
import { BsonFactory, parseShell, parseShellValue, ShellCommand, ShellParseError, shellCollection, shellStringify } from "./mongo-shell";
import type { ColumnFilter, DataTypeGroup, FilterGroup, IntrospectResult, QueryDetails, QueryResult, SqlFilter, StudioColumn, StudioTable } from "./types";

/* Minimal structural types for the parts of the `mongodb` driver Studio uses. */
type Doc = Record<string, unknown>;
interface Cursor<T = Doc> {
  sort(s: Doc): Cursor<T>;
  skip(n: number): Cursor<T>;
  limit(n: number): Cursor<T>;
  project(p: Doc): Cursor<T>;
  maxTimeMS(ms: number): Cursor<T>;
  toArray(): Promise<T[]>;
  close(): Promise<void>;
}
interface Collection {
  find(filter: Doc, options?: Doc): Cursor;
  findOne(filter: Doc, options?: Doc): Promise<Doc | null>;
  aggregate(pipeline: Doc[], options?: Doc): Cursor;
  countDocuments(filter: Doc, options?: Doc): Promise<number>;
  estimatedDocumentCount(): Promise<number>;
  distinct(key: string, filter?: Doc): Promise<unknown[]>;
  deleteMany(filter: Doc): Promise<{ deletedCount: number }>;
  [method: string]: unknown;
}
interface Db {
  collection(name: string): Collection;
  command(cmd: Doc): Promise<Doc>;
  listCollections(filter?: Doc, options?: Doc): { toArray(): Promise<{ name: string }[]> };
}
interface MongoLib {
  ObjectId: (new (hex?: string) => unknown) & { isValid(v: unknown): boolean };
  Decimal128: { fromString(s: string): unknown };
  Long: { fromString(s: string): unknown };
}

/** Cursor-returning reads, write methods and scalar reads the console understands. */
const CURSOR_METHODS = new Set(["find", "aggregate"]);
const CHAIN_METHODS = new Set(["sort", "skip", "limit", "project", "projection", "maxTimeMS", "toArray", "pretty", "batchSize", "hint", "collation", "comment"]);
const COLLECTION_METHODS = new Set([
  "find", "findOne", "aggregate", "countDocuments", "estimatedDocumentCount", "distinct",
  "insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany",
  "findOneAndUpdate", "findOneAndReplace", "findOneAndDelete", "bulkWrite",
  "createIndex", "dropIndex", "indexes", "listIndexes", "drop", "rename",
]);
const DB_METHODS = new Set(["runCommand", "getCollectionNames", "stats", "createCollection", "adminCommand"]);
const MAX_RAW_ROWS = 1000;
/** Server-side JavaScript is never accepted in filter-bar queries. */
const FORBIDDEN_OPERATORS = new Set(["$where", "$function", "$accumulator"]);

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** SQL LIKE pattern → anchored regex source (`\` escapes, `%` any run, `_` one char). */
function likeToRegex(pattern: string) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) out += escapeRegex(pattern[++i]);
    else if (ch === "%") out += ".*";
    else if (ch === "_") out += ".";
    else out += escapeRegex(ch);
  }
  return `^${out}$`;
}

/** The @ObjectIdColumn, or any reference field declared with `type: "objectId"`. */
function isOid(c: ColumnMetadata) {
  return c.isObjectId || typeName(c) === "objectid";
}

function getPath(doc: unknown, path: string): unknown {
  let cur = doc;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Doc)[part];
  }
  return cur;
}

/**
 * MongoDB counterpart of TypeormStudioAdapter: same procedures and wire
 * format, but collections are read with the native driver (TypeORM has no
 * query builder for MongoDB) and written through TypeORM's MongoRepository
 * so entity listeners, subscribers and transformers still run.
 *
 * Rows are keyed by each column's dotted document path (`address.city` for
 * embedded documents), which is also what Mongo filters, sorts and $set use.
 */
export class MongoStudioAdapter {
  constructor(private readonly dataSource: DataSource) {}

  private get lib(): MongoLib {
    return (this.dataSource.driver as unknown as { mongodb: MongoLib }).mongodb;
  }

  private get bson(): BsonFactory {
    const lib = this.lib;
    return {
      objectId: (hex) => (hex ? new lib.ObjectId(hex) : new lib.ObjectId()),
      decimal: (s) => lib.Decimal128.fromString(s),
      long: (s) => lib.Long.fromString(s),
    };
  }

  private db(name?: string): Db {
    const driver = this.dataSource.driver as unknown as { database?: string; queryRunner?: { databaseConnection: { db(n?: string): Db } } };
    if (!driver.queryRunner) throw new StudioError("The MongoDB connection is not initialized");
    return driver.queryRunner.databaseConnection.db(name ?? driver.database);
  }

  private collection(m: EntityMetadata): Collection {
    return this.db(m.database).collection(m.tableName);
  }

  /** Time an operation and show it in the Console view as a mongosh command. */
  private async track<T>(text: string, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      const out = await fn();
      logStudioOperation(text, performance.now() - started, null);
      return out;
    } catch (e) {
      logStudioOperation(text, performance.now() - started, (e as Error).message);
      throw e;
    }
  }

  /* ---------- introspection ---------- */

  introspect(): IntrospectResult {
    const ds = this.dataSource;
    const tables = ds.entityMetadatas
      .map((m) => this.describe(m))
      .sort((a, b) => a.id.localeCompare(b.id));
    const driver = ds.driver as unknown as { database?: string };
    return {
      driver: ds.options.type,
      database: driver.database ?? null,
      tables,
      filterOperators: FILTER_OPERATORS,
    };
  }

  private describe(m: EntityMetadata): StudioTable {
    const view = m.tableType === "view";
    return {
      id: m.name,
      tableName: m.tableName,
      schema: m.database ?? null,
      kind: view ? "view" : "entity",
      readOnly: view || m.primaryColumns.length === 0,
      primaryKeys: m.primaryColumns.map((c) => c.databasePath),
      columns: m.columns.map((c) => this.describeColumn(c)),
      // TypeORM's MongoDB driver has no relations (embedded documents are columns).
      relations: [],
    };
  }

  private group(c: ColumnMetadata): DataTypeGroup {
    if (isOid(c)) return "string";
    const t = typeName(c);
    if (t === "array") return "json";
    if (t === "object") return "json";
    return typeGroup(t, c);
  }

  private describeColumn(c: ColumnMetadata): StudioColumn {
    const type = typeName(c);
    const generated = c.isObjectId || c.isGenerated;
    return {
      name: c.databasePath,
      propertyPath: c.propertyPath,
      type,
      dbType: isOid(c) ? "objectId" : this.dbType(type),
      group: this.group(c),
      isArray: c.isArray || type === "array",
      nullable: c.isNullable,
      isPrimary: c.isPrimary,
      isGenerated: generated,
      generationStrategy: c.isObjectId ? "objectId" : (c.generationStrategy ?? null),
      isManaged: generated || c.isCreateDate || c.isUpdateDate || c.isDeleteDate || c.isVersion,
      defaultValue: stringifyDefault(c.default),
      enumValues: (c.enum ?? []).map(String),
      length: c.length ? String(c.length) : null,
      fk: null,
    };
  }

  /** BSON type names, as mongosh and Compass show them. */
  private dbType(type: string): string {
    const map: Record<string, string> = {
      string: "string", text: "string", varchar: "string", "simple-enum": "string", enum: "string",
      number: "double", int: "int", integer: "int", float: "double", double: "double", bigint: "long", decimal: "decimal",
      boolean: "bool", bool: "bool", date: "date", datetime: "date", timestamp: "date",
      array: "array", json: "object", object: "object", "simple-json": "string", "simple-array": "string",
    };
    return map[type] ?? type;
  }

  /* ---------- helpers ---------- */

  private meta(entity: string): EntityMetadata {
    const m = this.dataSource.entityMetadatas.find((x) => x.name === entity);
    if (!m) throw new StudioError(`Unknown entity "${entity}"`);
    return m;
  }

  private column(m: EntityMetadata, name: string): ColumnMetadata {
    const c = m.columns.find((x) => x.databasePath === name);
    if (!c) throw new StudioError(`Unknown column "${name}" on ${m.name}`);
    return c;
  }

  /** Turn UI input (JSON) into the value stored in the document. */
  private coerce(c: ColumnMetadata, v: unknown): unknown {
    if (v === null || v === undefined) return v;
    if (isOid(c)) {
      if (typeof v === "object" && (v as { _bsontype?: string })._bsontype) return v;
      const s = String(v).trim();
      if (!/^[0-9a-f]{24}$/i.test(s)) throw new StudioError(`"${s}" is not a valid ObjectId (${c.databasePath})`);
      return new this.lib.ObjectId(s);
    }
    const g = this.group(c);
    const t = typeName(c);
    if (typeof v === "string") {
      if (g === "numeric") {
        const n = Number(v);
        if (v.trim() === "" || Number.isNaN(n)) throw new StudioError(`"${v}" is not a number (${c.databasePath})`);
        return n;
      }
      if (g === "boolean") return v === "true" || v === "1";
      if (g === "datetime") {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) throw new StudioError(`"${v}" is not a valid date (${c.databasePath})`);
        return d;
      }
      if (g === "json") {
        try {
          return parseShellValue(v, this.bson);
        } catch {
          if (t === "array") return v.split(",").map((s) => s.trim());
          throw new StudioError(`Invalid JSON for ${c.databasePath}`);
        }
      }
      if (t === "simple-array") return v.split(",");
    }
    return v;
  }

  /** Entity-space value → stored value (column transformers), for filter parameters. */
  private persist(c: ColumnMetadata, v: unknown): unknown {
    if (v === null || v === undefined) return v;
    try {
      return this.dataSource.driver.preparePersistentValue(v, c);
    } catch {
      return v;
    }
  }

  private hydrate(m: EntityMetadata, doc: Doc | null | undefined): Record<string, unknown> {
    if (!doc) return doc as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const c of m.columns) {
      const v = getPath(doc, c.databasePath);
      try {
        out[c.databasePath] = v === undefined ? null : this.dataSource.driver.prepareHydratedValue(v, c);
      } catch {
        out[c.databasePath] = v ?? null;
      }
    }
    return out;
  }

  /* ---------- filtering (FilterGroup tree → Mongo query document) ---------- */

  /** AND binds tighter than OR, as in the SQL the other databases get. */
  private buildFilter(m: EntityMetadata, group: FilterGroup): Doc {
    const runs: Doc[][] = [[]];
    let first = true;
    group.filters.forEach((f, idx) => {
      if (f.kind === "FilterGroup" && f.filters.length === 0) return;
      if (f.kind === "SqlFilter" && !f.sql.trim()) return;
      const joiner = first ? "and" : group.filters[idx - 1].after;
      first = false;
      const cond =
        f.kind === "FilterGroup" ? this.buildFilter(m, f) : f.kind === "SqlFilter" ? this.rawFilter(f) : this.condition(m, f);
      if (joiner === "or") runs.push([cond]);
      else runs[runs.length - 1].push(cond);
    });
    const ands = runs.filter((r) => r.length).map((r) => (r.length === 1 ? r[0] : { $and: r }));
    if (!ands.length) return {};
    return ands.length === 1 ? ands[0] : { $or: ands };
  }

  /** The filter bar's raw clause holds a Mongo query document on this database. */
  private rawFilter(f: SqlFilter): Doc {
    let v: unknown;
    try {
      v = parseShellValue(f.sql.trim(), this.bson);
    } catch (e) {
      throw new StudioError(`Invalid Mongo filter: ${(e as Error).message}`);
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new StudioError("A Mongo filter must be a document, e.g. { views: { $gt: 100 } }");
    const check = (x: unknown) => {
      if (Array.isArray(x)) x.forEach(check);
      else if (x && typeof x === "object" && !(x as { _bsontype?: string })._bsontype && !(x instanceof Date) && !(x instanceof RegExp)) {
        for (const [k, val] of Object.entries(x)) {
          if (FORBIDDEN_OPERATORS.has(k)) throw new StudioError(`${k} (server-side JavaScript) is not allowed in filters`);
          check(val);
        }
      }
    };
    check(v);
    return v as Doc;
  }

  private textMatch(c: ColumnMetadata, source: string, options: string): Doc {
    const path = c.databasePath;
    const g = this.group(c);
    if (!isOid(c) && (g === "string" || g === "enum" || typeName(c) === "array")) {
      return { [path]: { $regex: source, $options: options } };
    }
    // Numbers, ObjectIds, dates: match against the value's text form, like CAST(... AS TEXT) in SQL.
    return {
      $expr: {
        $regexMatch: {
          input: { $convert: { input: `$${path}`, to: "string", onError: "", onNull: "" } },
          regex: source,
          options,
        },
      },
    };
  }

  private condition(m: EntityMetadata, f: ColumnFilter): Doc {
    const c = this.column(m, f.column);
    const path = c.databasePath;
    const value = f.value;
    const str = value === null || value === undefined ? "" : String(value);
    const val = () => this.persist(c, this.coerce(c, value));
    switch (f.operator) {
      case "is null":
        return { [path]: null };
      case "is not null":
        return { [path]: { $ne: null } };
      case "contains":
        return this.textMatch(c, escapeRegex(str), "i");
      case "not contains":
        return { $nor: [this.textMatch(c, escapeRegex(str), "i")] };
      case "starts with":
        return this.textMatch(c, "^" + escapeRegex(str), "i");
      case "ends with":
        return this.textMatch(c, escapeRegex(str) + "$", "i");
      case "like":
        return this.textMatch(c, likeToRegex(str), "s");
      case "in": {
        const list = Array.isArray(value) ? value : str.split(",").map((s) => s.trim()).filter(Boolean);
        return { [path]: { $in: list.map((v) => this.persist(c, this.coerce(c, v))) } };
      }
      case "=":
        return { [path]: val() };
      case "!=":
        return { [path]: { $ne: val() } };
      case ">":
        return { [path]: { $gt: val() } };
      case ">=":
        return { [path]: { $gte: val() } };
      case "<":
        return { [path]: { $lt: val() } };
      case "<=":
        return { [path]: { $lte: val() } };
      default:
        throw new StudioError(`Unsupported operator "${(f as ColumnFilter).operator}"`);
    }
  }

  /** Full-table search: OR of case-insensitive `contains` over text-like fields. */
  private searchFilter(m: EntityMetadata, term: string): Doc | null {
    const needle = term.trim();
    if (!needle) return null;
    const numeric = /^-?\d+(\.\d+)?$/.test(needle);
    const cols = m.columns
      .filter((c) => {
        const g = this.group(c);
        return g === "string" || g === "enum" || typeName(c) === "array" || (g === "numeric" && numeric);
      })
      .slice(0, 64);
    if (!cols.length) return null;
    return { $or: cols.map((c) => this.textMatch(c, escapeRegex(needle), "i")) };
  }

  /* ---------- reading ---------- */

  async query(d: QueryDetails): Promise<QueryResult> {
    const m = this.meta(d.table);
    const pageSize = Math.min(Math.max(1, Math.floor(d.pageSize) || 50), MAX_PAGE_SIZE);
    const pageIndex = Math.max(0, Math.floor(d.pageIndex) || 0);
    const parts: Doc[] = [];
    if (d.filter && d.filter.filters.length) {
      const f = this.buildFilter(m, d.filter);
      if (Object.keys(f).length) parts.push(f);
    }
    const search = d.search ? this.searchFilter(m, d.search) : null;
    if (search) parts.push(search);
    const filter: Doc = parts.length === 0 ? {} : parts.length === 1 ? parts[0] : { $and: parts };

    const sort: Doc = {};
    for (const s of d.sortOrder ?? []) sort[this.column(m, s.column).databasePath] = s.direction === "desc" ? -1 : 1;
    // Stable pagination: fall back to the primary key (_id).
    for (const pk of m.primaryColumns) if (!(pk.databasePath in sort)) sort[pk.databasePath] = 1;

    // Search gets the same 5 s budget as on SQL databases, enforced by the server.
    const limits = search ? { maxTimeMS: SEARCH_TIMEOUT_MS } : {};
    const coll = this.collection(m);
    const name = shellCollection(m.tableName);
    const findText = `${name}.find(${shellStringify(filter)}).sort(${shellStringify(sort)}).skip(${pageIndex * pageSize}).limit(${pageSize})`;
    const countText = `${name}.countDocuments(${shellStringify(filter)})`;
    const started = Date.now();
    try {
      const [docs, count] = await Promise.all([
        this.track(findText, () =>
          coll.find(filter, { sort, skip: pageIndex * pageSize, limit: pageSize, allowDiskUse: true, ...limits }).toArray(),
        ),
        this.track(countText, () => coll.countDocuments(filter, limits)),
      ]);
      return {
        rows: docs.map((doc) => this.hydrate(m, doc)),
        filteredRowCount: count,
        sql: findText,
        durationMs: Date.now() - started,
      };
    } catch (e) {
      const err = e as Error & { codeName?: string; code?: number };
      if (err.codeName === "MaxTimeMSExpired" || err.code === 50) throw new StudioError(SEARCH_TIMEOUT_MESSAGE, findText);
      throw new StudioError(err.message, findText);
    }
  }

  async count(tables?: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const metas = this.dataSource.entityMetadatas.filter((m) => !tables || tables.includes(m.name));
    await Promise.all(
      metas.map(async (m) => {
        try {
          out[m.name] = await this.track(`${shellCollection(m.tableName)}.estimatedDocumentCount()`, () => this.collection(m).estimatedDocumentCount());
        } catch {
          out[m.name] = -1;
        }
      }),
    );
    return out;
  }

  private async reload(m: EntityMetadata, id: unknown) {
    const pk = m.primaryColumns[0];
    const filter = { [pk.databasePath]: id };
    const doc = await this.track(`${shellCollection(m.tableName)}.findOne(${shellStringify(filter)})`, () => this.collection(m).findOne(filter));
    return this.hydrate(m, doc);
  }

  /* ---------- writing (through TypeORM so listeners/subscribers/transformers run) ---------- */

  private assertWritable(m: EntityMetadata) {
    if (m.tableType === "view") throw new StudioError(`${m.name} is a view and cannot be modified`);
    if (m.primaryColumns.length !== 1) throw new StudioError(`${m.name} has no single primary key; it is read-only in Studio`);
  }

  private pkValue(m: EntityMetadata, row: Record<string, unknown>) {
    const pk = m.primaryColumns[0];
    if (!(pk.databasePath in row) || row[pk.databasePath] === null) throw new StudioError(`Row is missing primary key ${pk.databasePath}`);
    return this.coerce(pk, row[pk.databasePath]);
  }

  private apply(m: EntityMetadata, entity: ObjectLiteral, values: Record<string, unknown>) {
    for (const [name, raw] of Object.entries(values)) {
      const c = this.column(m, name);
      c.setEntityValue(entity, this.coerce(c, raw));
    }
    return entity;
  }

  async insert(table: string, rows: Record<string, unknown>[]) {
    const m = this.meta(table);
    this.assertWritable(m);
    const repo = this.dataSource.getMongoRepository(m.target);
    const pk = m.primaryColumns[0];
    const out: Record<string, unknown>[] = [];
    // MongoDB transactions need a replica set and TypeORM does not drive them, so rows are saved one by one.
    for (const row of rows) {
      const clean = Object.fromEntries(
        Object.entries(row).filter(([k, v]) => v !== undefined && (v !== "" || this.group(this.column(m, k)) === "string")),
      );
      if (pk.isObjectId && clean[pk.databasePath] === "") delete clean[pk.databasePath];
      const entity = this.apply(m, repo.create(), clean);
      const saved = await this.track(`${shellCollection(m.tableName)}.insertOne(${shellStringify(clean)})`, () => repo.save(entity));
      out.push(await this.reload(m, pk.getEntityValue(saved)));
    }
    return { rows: out };
  }

  async update(table: string, updates: { row: Record<string, unknown>; changes: Record<string, unknown> }[]) {
    const m = this.meta(table);
    this.assertWritable(m);
    const repo = this.dataSource.getMongoRepository(m.target);
    const pk = m.primaryColumns[0];
    const ids: unknown[] = [];
    for (const u of updates) {
      const id = this.pkValue(m, u.row);
      ids.push(id);
      if (!Object.keys(u.changes).length) continue;
      if (pk.databasePath in u.changes) throw new StudioError(`${pk.databasePath} can't be changed on MongoDB documents`);
      const filter = { [pk.databasePath]: id };
      const text = `${shellCollection(m.tableName)}.updateOne(${shellStringify(filter)}, { $set: ${shellStringify(u.changes)} })`;
      await this.track(text, async () => {
        // Load → change → save, so @UpdateDateColumn, @VersionColumn, listeners and subscribers behave as in the app.
        const entity = await repo.findOne({ where: filter } as never);
        if (!entity) throw new StudioError(`Row no longer exists in ${m.name}`);
        await repo.save(this.apply(m, entity, u.changes));
      });
    }
    return { rows: await Promise.all(ids.map((id) => this.reload(m, id))) };
  }

  async delete(table: string, rows: Record<string, unknown>[]) {
    const m = this.meta(table);
    this.assertWritable(m);
    const pk = m.primaryColumns[0];
    const filter = { [pk.databasePath]: { $in: rows.map((r) => this.pkValue(m, r)) } };
    const res = await this.track(`${shellCollection(m.tableName)}.deleteMany(${shellStringify(filter)})`, () => this.collection(m).deleteMany(filter));
    return { affected: res.deletedCount };
  }

  /* ---------- query console (mongosh subset) ---------- */

  private parse(text: string): ShellCommand[] {
    const commands = parseShell(text, this.bson);
    for (const c of commands) {
      if (c.collection === null && !DB_METHODS.has(c.method)) {
        throw new ShellParseError(`Unsupported database method db.${c.method}() (try ${[...DB_METHODS].join(", ")})`, c.from, c.to);
      }
      if (c.collection !== null && !COLLECTION_METHODS.has(c.method)) {
        throw new ShellParseError(`Unsupported collection method .${c.method}()`, c.from, c.to);
      }
      for (const link of c.chain) {
        if (!CURSOR_METHODS.has(c.method) || !CHAIN_METHODS.has(link.name)) {
          throw new ShellParseError(`.${link.name}() can't follow .${c.method}()`, link.from, link.from + link.name.length);
        }
      }
    }
    return commands;
  }

  async raw(sql: string) {
    const started = Date.now();
    let commands: ShellCommand[];
    try {
      commands = this.parse(sql);
    } catch (e) {
      throw new StudioError((e as Error).message, sql);
    }
    if (!commands.length) throw new StudioError("Nothing to run. Try db.getCollectionNames()", sql);
    let last: { rows: Doc[]; rowCount: number } = { rows: [], rowCount: 0 };
    for (const c of commands) {
      const text = sql.slice(c.from, c.to);
      try {
        last = await this.track(text, () => this.run(c));
      } catch (e) {
        throw new StudioError((e as Error).message, text);
      }
    }
    return { ...last, durationMs: Date.now() - started };
  }

  private async run(c: ShellCommand): Promise<{ rows: Doc[]; rowCount: number }> {
    const db = this.db();
    const asRows = (v: unknown): Doc[] =>
      Array.isArray(v) ? v.map((x) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Doc) : { value: x })) : v && typeof v === "object" ? [v as Doc] : [{ value: v }];
    if (c.collection === null) {
      switch (c.method) {
        case "getCollectionNames": {
          const list = await db.listCollections({}, { nameOnly: true }).toArray();
          const rows = list.map((x) => ({ name: x.name })).sort((a, b) => a.name.localeCompare(b.name));
          return { rows, rowCount: rows.length };
        }
        case "stats":
          return { rows: [await db.command({ dbStats: 1 })], rowCount: 0 };
        case "createCollection":
          return { rows: [await db.command({ create: c.args[0], ...((c.args[1] as Doc) ?? {}) })], rowCount: 0 };
        case "adminCommand": {
          const admin = (db as unknown as { admin(): { command(d: Doc): Promise<Doc> } }).admin();
          return { rows: [await admin.command(c.args[0] as Doc)], rowCount: 0 };
        }
        default:
          return { rows: [await db.command(c.args[0] as Doc)], rowCount: 0 };
      }
    }
    const coll = db.collection(c.collection);
    // mongosh: find(filter, projection, options); the Node driver: find(filter, { projection, ...options }).
    if ((c.method === "find" || c.method === "findOne") && c.args.length > 1) {
      const [filter, projection, options] = c.args;
      c = { ...c, args: [filter ?? {}, { ...((options as Doc) ?? {}), ...(projection ? { projection } : {}) }] };
    }
    if (CURSOR_METHODS.has(c.method)) {
      let cursor = (coll[c.method] as (...a: unknown[]) => Cursor).apply(coll, c.args);
      let limited = false;
      for (const link of c.chain) {
        if (link.name === "toArray" || link.name === "pretty") continue;
        const name = link.name === "projection" ? "project" : link.name;
        if (name === "limit") limited = true;
        const fn = (cursor as unknown as Record<string, (...a: unknown[]) => Cursor>)[name];
        if (typeof fn !== "function") throw new StudioError(`.${link.name}() is not supported here`);
        cursor = fn.apply(cursor, link.args);
      }
      // Never stream an unbounded collection into the browser.
      if (!limited) cursor = cursor.limit(MAX_RAW_ROWS + 1);
      const docs = await cursor.toArray();
      return { rows: docs.slice(0, limited ? undefined : MAX_RAW_ROWS), rowCount: docs.length };
    }
    const result = await (coll[c.method] as (...a: unknown[]) => Promise<unknown>).apply(coll, c.args);
    if (c.method === "indexes" || c.method === "listIndexes") {
      const list = Array.isArray(result) ? result : await (result as { toArray(): Promise<Doc[]> }).toArray();
      return { rows: list as Doc[], rowCount: (list as Doc[]).length };
    }
    if (c.method === "countDocuments" || c.method === "estimatedDocumentCount") return { rows: [{ count: result }], rowCount: 0 };
    if (c.method === "distinct") return { rows: asRows(result), rowCount: (result as unknown[]).length };
    if (c.method === "findOne") return { rows: result ? [result as Doc] : [], rowCount: result ? 1 : 0 };
    // Write results (insertOne, updateMany, deleteMany…) report what they changed.
    const r = (result ?? {}) as Doc;
    const affected = Number(r.insertedCount ?? 0) + Number(r.modifiedCount ?? 0) + Number(r.deletedCount ?? 0) + Number(r.upsertedCount ?? 0);
    if (c.method.startsWith("findOneAnd")) {
      const doc = (r as { value?: Doc }).value !== undefined ? (r as { value?: Doc }).value : (r as Doc);
      return { rows: doc ? [doc] : [], rowCount: doc ? 1 : 0 };
    }
    if (typeof result !== "object" || result === null) return { rows: [{ result }], rowCount: 0 };
    if ("insertedId" in r) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: affected || Number(r.matchedCount ?? 0) };
  }

  /* ---------- editor support ---------- */

  sqlSchema() {
    const namespace: Record<string, string[]> = {};
    for (const m of this.dataSource.entityMetadatas) namespace[m.tableName] = m.columns.map((c) => c.databasePath);
    return { dialect: "mongodb", namespace, entities: Object.fromEntries(this.dataSource.entityMetadatas.map((m) => [m.name, m.tableName])) };
  }

  /** Parse-only diagnostics: nothing is sent to the server. */
  async lint(sql: string) {
    if (sql.length > 50_000) return { diagnostics: [] };
    try {
      this.parse(sql);
      return { diagnostics: [] };
    } catch (e) {
      const err = e as ShellParseError;
      const from = Math.min(err.offset ?? 0, sql.length);
      const to = Math.max(from + 1, Math.min(err.end ?? from + 1, sql.length));
      return { diagnostics: [{ from, to, message: err.message, severity: "error" as const }] };
    }
  }
}
