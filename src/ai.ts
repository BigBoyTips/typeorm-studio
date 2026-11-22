import type Anthropic from "@anthropic-ai/sdk";
import type { IntrospectResult } from "./types";

/**
 * Optional natural-language assistant (cf. Prisma Studio's `StudioLlm`):
 * turns a request like "unpublished posts by Ada with > 100 views" into
 * either a filter for the current table or a SQL query for the console.
 *
 * Uses the official Anthropic SDK. Enabled only when credentials resolve
 * (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile).
 */

export const AI_MODEL = process.env.TYPEORM_STUDIO_AI_MODEL || "claude-opus-5-5";

export interface AiRequest {
  prompt: string;
  /** "filter": build a filter for `table`; "sql": write SQL; "auto": let the model choose. */
  mode: "filter" | "sql" | "auto";
  table?: string;
  /** Current SQL in the console, for "fix/extend this" requests. */
  sql?: string;
}

export interface AiResult {
  mode: "filter" | "sql";
  sql: string | null;
  filters: { column: string; operator: string; value: string | null; after: "and" | "or" }[] | null;
  explanation: string;
}

const OPERATORS = ["=", "!=", ">", ">=", "<", "<=", "is null", "is not null", "contains", "not contains", "starts with", "ends with", "like", "in"];

const SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["filter", "sql"] },
    sql: { type: ["string", "null"], description: "The SQL query when mode is sql, otherwise null." },
    filters: {
      type: ["array", "null"],
      description: "Column filters for the current table when mode is filter, otherwise null.",
      items: {
        type: "object",
        properties: {
          column: { type: "string", description: "Database column name of the current table." },
          operator: { type: "string", enum: OPERATORS },
          value: { type: ["string", "null"], description: "Comparison value; comma-separated for 'in'; null for is null / is not null." },
          after: { type: "string", enum: ["and", "or"], description: "How this filter joins the next one." },
        },
        required: ["column", "operator", "value", "after"],
        additionalProperties: false,
      },
    },
    explanation: { type: "string", description: "One short sentence describing what the result does." },
  },
  required: ["mode", "sql", "filters", "explanation"],
  additionalProperties: false,
} as const;

let clientPromise: Promise<Anthropic | null> | null = null;

/**
 * Whether the assistant can run: the optional `@anthropic-ai/sdk` peer is
 * installed and credentials resolve. Returns a boolean so the published type
 * declarations never reference the SDK, which most users do not install.
 */
export function aiAvailable(): Promise<boolean> {
  return getAiClient().then((c) => !!c);
}

/** Lazily construct the client; null when the SDK or credentials are unavailable. */
function getAiClient(): Promise<Anthropic | null> {
  if (process.env.TYPEORM_STUDIO_AI === "off") return Promise.resolve(null);
  clientPromise ??= (async () => {
    try {
      const { default: AnthropicSDK } = await import("@anthropic-ai/sdk");
      const hasEnvCredentials = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
      const client = new AnthropicSDK();
      // Without env credentials, the SDK may still find an `ant auth login` profile;
      // constructing succeeds either way, so only treat it as enabled when something resolved.
      if (!hasEnvCredentials && !process.env.ANTHROPIC_PROFILE && !process.env.ANTHROPIC_FEDERATION_RULE_ID) {
        const fs = await import("fs");
        const os = await import("os");
        const path = await import("path");
        if (!fs.existsSync(path.join(os.homedir(), ".config", "anthropic"))) return null;
      }
      return client;
    } catch {
      return null;
    }
  })();
  return clientPromise;
}

function describeSchema(meta: IntrospectResult): string {
  return meta.tables
    .map((t) => {
      const cols = t.columns
        .map((c) => {
          const bits = [c.name, c.type + (c.nullable ? "?" : "")];
          if (c.isPrimary) bits.push("pk");
          if (c.enumValues.length) bits.push(`enum(${c.enumValues.join("|")})`);
          if (c.fk) bits.push(`-> ${c.fk.entity}.${c.fk.column}`);
          return "  " + bits.join(" ");
        })
        .join("\n");
      const rels = t.relations.map((r) => `  relation ${r.name}: ${r.kind} ${r.target}`).join("\n");
      return `entity ${t.id} (table ${t.schema ? t.schema + "." : ""}${t.tableName})\n${cols}${rels ? "\n" + rels : ""}`;
    })
    .join("\n\n");
}

export async function askAi(meta: IntrospectResult, dialect: string, req: AiRequest): Promise<AiResult> {
  const client = await getAiClient();
  if (!client) throw new Error("AI is not configured. Set ANTHROPIC_API_KEY (or run `ant auth login`) and restart Studio.");
  const prompt = req.prompt.trim();
  if (!prompt) throw new Error("Describe what you want first.");
  if (prompt.length > 4000) throw new Error("Request is too long (max 4000 characters).");

  const mongo = dialect === "mongodb";
  const system = [
    "You help people query a database inside TypeORM Studio, a data browser.",
    ...(mongo
      ? [
          "The database is MongoDB. Tables below are collections; columns are document fields (dotted paths for embedded documents); _id holds ObjectIds.",
          "Return mode 'filter' with a list of column filters when the request can be answered by filtering documents of the current collection; otherwise return mode 'sql' where the sql field holds one read-only mongosh command, e.g. db.users.find({ age: { $gt: 30 } }).sort({ name: 1 }).limit(20) or db.posts.aggregate([...]).",
          "In commands use only db.<collection>.<method>(...) with JavaScript object literals and the helpers ObjectId(\"…\") and ISODate(\"…\"); no variables, functions or $where.",
          "Only write data-modifying commands (insertOne, updateMany, deleteMany…) when the user explicitly asks to change data. Never drop collections or indexes.",
        ]
      : [
          `The database dialect is ${dialect}. Quote identifiers the way that dialect requires when they are reserved words or mixed case.`,
          "Return mode 'filter' with a list of column filters when the request can be answered by filtering rows of the current table; otherwise return mode 'sql' with one read-only SELECT statement.",
          "Only write data-modifying SQL (INSERT/UPDATE/DELETE) when the user explicitly asks to change data. Never write DDL.",
        ]),
    "Use only tables and columns from the schema below. Filters must use database column names of the current table and the allowed operators. Boolean values are 'true'/'false'; dates are ISO 8601.",
    "",
    "Schema:",
    describeSchema(meta),
  ].join("\n");

  const context = [
    req.table ? `Current table: ${req.table}` : "No table is open.",
    req.mode === "filter" ? "The user is in the filter bar: prefer mode 'filter'." : "",
    req.mode === "sql" ? "The user is in the SQL console: use mode 'sql'." : "",
    req.sql?.trim() ? `Current SQL in the console:\n${req.sql.trim()}` : "",
    "",
    `Request: ${prompt}`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  // Server-side fallback ("default" form) re-runs a request a safety classifier
  // declines on Anthropic's recommended substitute model, inside the same call.
  const response = await client.beta.messages.create({
    model: AI_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> },
    },
    messages: [{ role: "user", content: context }],
  });

  if (response.stop_reason === "refusal") throw new Error("The assistant declined this request.");
  if (response.stop_reason === "max_tokens") throw new Error("The assistant's answer was cut off. Try a narrower request.");
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  let parsed: AiResult;
  try {
    parsed = JSON.parse(text) as AiResult;
  } catch {
    throw new Error("The assistant returned an unreadable answer. Try again.");
  }
  if (parsed.mode === "filter" && req.table) {
    const table = meta.tables.find((t) => t.id === req.table);
    const known = new Set(table?.columns.map((c) => c.name));
    parsed.filters = (parsed.filters ?? []).filter((f) => known.has(f.column) && OPERATORS.includes(f.operator));
  }
  return parsed;
}
