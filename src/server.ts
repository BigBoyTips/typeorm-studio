import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as zlib from "zlib";
import type { DataSource } from "typeorm";
import { StudioError, TypeormStudioAdapter } from "./adapter";
import { CapturedQuery, QueryInsights, studioContext } from "./insights";
import { MongoStudioAdapter } from "./mongo";
import { migrationStatus, schemaDiff } from "./schema";
import type { FilterGroup, StudioRequest, StudioResponse } from "./types";

const UI_DIR = path.resolve(__dirname, "..", "ui");
const MAX_BODY = 10 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

/** JSON-safe encoding for driver values (bigint, Buffer, Date). */
function replacer(_key: string, value: unknown) {
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value === "object" && (value as { type?: string }).type === "Buffer" && Array.isArray((value as { data?: unknown }).data)) {
    return { $binary: Buffer.from((value as { data: number[] }).data).toString("base64") };
  }
  return value;
}

export interface StudioHandlerOptions {
  /** Disable writes and raw SQL. */
  readOnly?: boolean;
  /** Record queries for the Query Insights view (default true). */
  insights?: boolean;
  /**
   * Accept only requests whose Host header names one of these hosts (DNS-rebinding protection).
   * The CLI sets this to the loopback names when it listens on localhost.
   */
  allowedHosts?: string[];
}

const READ_ONLY_PROCEDURES = new Set(["introspect", "count", "query", "sql-schema", "insights", "schema-diff", "migrations"]);

/**
 * The "BFF" (backend-for-frontend) procedure dispatcher.
 * Mirrors Prisma Studio's single-endpoint `{ procedure, ... }` protocol.
 */
export function createStudioDispatcher(dataSource: DataSource, options: StudioHandlerOptions = {}) {
  const mongo = dataSource.options.type === "mongodb";
  const adapter = mongo ? new MongoStudioAdapter(dataSource) : new TypeormStudioAdapter(dataSource);
  // Always installed: it also captures each operation's SQL for the Console view.
  const recorder = QueryInsights.shared(dataSource);
  if (options.insights !== false) recorder.enabled = true;
  const insights = options.insights === false ? null : recorder;

  async function handle(req: StudioRequest): Promise<unknown> {
    if (options.readOnly && !READ_ONLY_PROCEDURES.has(req.procedure)) {
      throw new StudioError("Studio is running in read-only mode");
    }
    if (options.readOnly && req.procedure === "query" && hasSqlFilter(req.filter)) {
      throw new StudioError("SQL filters are disabled in read-only mode");
    }
    switch (req.procedure) {
      case "introspect":
        return {
          ...adapter.introspect(),
          readOnly: !!options.readOnly,
          capabilities: {
            sqlEditor: !options.readOnly,
            sqlLint: !options.readOnly,
            // MongoDB operations bypass QueryRunner.query, so there is no app traffic to record.
            insights: !!insights && !mongo,
            schemaDiff: !mongo,
            fullTableSearch: true,
            /** "sql", or "mongodb" for the mongosh-style console and JSON filters. */
            queryLanguage: mongo ? "mongodb" : "sql",
          },
        };
      case "count":
        return adapter.count(req.tables);
      case "query":
        return adapter.query(req);
      case "insert":
        return adapter.insert(req.table, req.rows);
      case "update":
        return adapter.update(req.table, req.updates);
      case "delete":
        return adapter.delete(req.table, req.rows);
      case "raw":
        return adapter.raw(req.sql);
      case "sql-schema":
        return adapter.sqlSchema();
      case "sql-lint":
        return adapter.lint(req.sql);
      case "insights":
        if (!insights || mongo) throw new StudioError(mongo ? "Query insights are not available for MongoDB" : "Query insights are disabled");
        if (req.reset) insights.reset();
        return insights.snapshot({ since: req.since, limit: req.limit, includeStudio: req.includeStudio });
      case "schema-diff":
        return schemaDiff(dataSource);
      case "migrations":
        return migrationStatus(dataSource);
      default:
        throw new StudioError(`Unknown procedure "${(req as { procedure: string }).procedure}"`);
    }
  }

  return async function dispatch(req: StudioRequest): Promise<StudioResponse> {
    // Tag Studio's own queries (for Query Insights) and capture the SQL this operation ran (for the Console).
    const ctx = { studio: true as const, log: [] as CapturedQuery[] };
    try {
      const result = await studioContext.run(ctx, () => handle(req));
      return { ok: true, result, queries: ctx.log };
    } catch (e) {
      const err = e as Error & { query?: string };
      return { ok: false, error: { name: err.name || "Error", message: err.message, query: err.query }, queries: ctx.log };
    }
  };
}

function hasSqlFilter(g: FilterGroup | undefined): boolean {
  return !!g?.filters?.some((f) => f.kind === "SqlFilter" || (f.kind === "FilterGroup" && hasSqlFilter(f)));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new StudioError("Request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * A Node `(req, res)` handler you can mount in Express/Fastify/http:
 *   app.use("/studio", createStudioHandler(dataSource))
 */
export function createStudioHandler(dataSource: DataSource, options: StudioHandlerOptions = {}) {
  const dispatch = createStudioDispatcher(dataSource, options);
  return async function handler(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    // strip any mount prefix: everything after the last "/api" or static file name
    const pathname = url.pathname;

    const fail = (status: number, message: string) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { name: "Forbidden", message } }));
    };
    if (options.allowedHosts && !hostAllowed(req.headers.host, options.allowedHosts)) {
      return fail(403, "Invalid Host header");
    }

    if (req.method === "POST" && pathname.endsWith("/api")) {
      // CSRF: only same-origin JSON requests. A non-JSON content type would let any web page
      // send a "simple" cross-site request without a CORS preflight.
      const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (type !== "application/json") return fail(415, "Expected Content-Type: application/json");
      if (!sameOrigin(req)) return fail(403, "Cross-origin requests are not allowed");
      let body: StudioResponse;
      try {
        body = await dispatch(JSON.parse(await readBody(req)) as StudioRequest);
      } catch (e) {
        body = { ok: false, error: { name: "BadRequest", message: (e as Error).message } };
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body, replacer));
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      // Works under any mount prefix: serve "<file>" or "vendor/<file>" from the UI folder.
      const m = /(?:^|\/)((?:vendor\/)?[\w.-]+)$/.exec(pathname);
      const file = m && MIME[path.extname(m[1])] ? m[1] : "index.html";
      const full = path.join(UI_DIR, file);
      const asset = full.startsWith(UI_DIR) ? await loadAsset(full) : null;
      if (!asset) {
        res.writeHead(404).end("Not found");
        return;
      }
      const headers: http.OutgoingHttpHeaders = {
        "content-type": MIME[path.extname(full)] ?? "application/octet-stream",
        "cache-control": file.startsWith("vendor/") ? "public, max-age=86400" : "no-cache",
        etag: asset.etag,
        vary: "Accept-Encoding",
      };
      if (req.headers["if-none-match"] === asset.etag) {
        res.writeHead(304, headers).end();
        return;
      }
      const gzip = asset.gzip && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
      const body = gzip ? asset.gzip! : asset.raw;
      if (gzip) headers["content-encoding"] = "gzip";
      headers["content-length"] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    res.writeHead(405).end("Method not allowed");
  };
}

interface Asset {
  mtimeMs: number;
  size: number;
  etag: string;
  raw: Buffer;
  gzip: Buffer | null;
}
const assets = new Map<string, Asset>();

/**
 * UI files are read and gzipped once, then served from memory. The mtime/size
 * check keeps edits to ui/ visible without restarting.
 */
async function loadAsset(full: string): Promise<Asset | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(full);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const cached = assets.get(full);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
  const raw = await fs.promises.readFile(full);
  const packed = raw.length > 1024 ? zlib.gzipSync(raw) : null;
  const asset: Asset = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    // Weak: the same validator covers the gzip and identity bodies.
    etag: `W/"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`,
    raw,
    gzip: packed && packed.length < raw.length ? packed : null,
  };
  assets.set(full, asset);
  return asset;
}

function sameOrigin(req: http.IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl, tests) send no Origin
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function hostAllowed(hostHeader: string | undefined, allowed: string[]): boolean {
  if (!hostHeader) return false;
  let host: string;
  try {
    host = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  return allowed.some((h) => h.replace(/^\[|\]$/g, "").toLowerCase() === host);
}

const LOOPBACK = ["localhost", "127.0.0.1", "::1"];

export function startStudio(
  dataSource: DataSource,
  opts: { port?: number; host?: string } & StudioHandlerOptions = {},
): Promise<http.Server> {
  const host = opts.host ?? "127.0.0.1";
  // On a loopback address, also refuse foreign Host headers (DNS rebinding).
  const loopback = LOOPBACK.includes(host) || host.startsWith("127.");
  const handler = createStudioHandler(dataSource, {
    ...opts,
    allowedHosts: opts.allowedHosts ?? (loopback ? [...LOOPBACK, host] : undefined),
  });
  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => {
      res.writeHead(500).end(String(e));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 5555, host, () => resolve(server));
  });
}
