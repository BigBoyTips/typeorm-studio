import { AsyncLocalStorage } from "async_hooks";
import type { DataSource, QueryRunner } from "typeorm";

/**
 * Query Insights: records every SQL statement that goes through the
 * DataSource (your app's queries as well as Studio's own), grouped by
 * normalised statement text.
 *
 * Mirrors the shape of Prisma Studio's `StudioQueryInsightQuery`
 * (count, duration, min/max, rowsReturned, tables, lastSeen).
 */

export interface InsightQuery {
  id: string;
  query: string;
  source: "app" | "studio";
  count: number;
  /** Total duration, ms. */
  duration: number;
  minDurationMs: number;
  maxDurationMs: number;
  rowsReturned: number;
  errors: number;
  tables: string[];
  lastSeen: number;
  lastError: string | null;
}

export interface InsightsSnapshot {
  generatedAt: number;
  since: number;
  totalQueries: number;
  queries: InsightQuery[];
}

/** One SQL statement executed while serving a Studio request (shown in the Console view). */
export interface CapturedQuery {
  sql: string;
  parameters: unknown[];
  durationMs: number;
  error: string | null;
}

/**
 * Marks queries issued by Studio itself so the UI can tell them apart from app
 * traffic, and collects the SQL each Studio operation ran.
 */
export const studioContext = new AsyncLocalStorage<{ studio: true; log?: CapturedQuery[] }>();

const WRAPPED = Symbol.for("typeorm-studio.insights.wrapped");
/** The driver remembers the recorder currently in charge, so a newer dispatcher takes over. */
const RECORDER = Symbol.for("typeorm-studio.insights.recorder");
/** Recording is on while at least one dispatcher wants it. */
const MAX_CAPTURED = 50;
const MAX_GROUPS = 500;

function normalise(sql: string): string {
  return sql
    .replace(/\s+/g, " ")
    .replace(/'(?:[^']|'')*'/g, "?") // string literals
    .replace(/\b\d+(\.\d+)?\b/g, "?") // numbers
    .replace(/\$\d+|@\d+|:\w+/g, "?") // driver placeholders
    .replace(/\(\s*\?(\s*,\s*\?)+\s*\)/g, "(?…)") // IN lists
    .trim();
}

function tablesOf(sql: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:from|join|into|update|table)\s+((?:["`[]?[\w$]+["`\]]?\.)?["`[]?[\w$]+["`\]]?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const name = m[1].replace(/["`[\]]/g, "");
    if (!/^(select|lateral|unnest|json_each)$/i.test(name)) out.add(name);
  }
  return [...out];
}

const IGNORED = /^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|SAVEPOINT|RELEASE|SET\s|PRAGMA)/i;
const MAX_SHAPES = 2000;

/**
 * Parameterised app SQL repeats verbatim, so the regex work (noise check,
 * normalisation, table extraction) is done once per distinct statement text.
 * `null` marks statements that are not recorded.
 */
const shapes = new Map<string, { query: string; tables: string[] } | null>();
function shapeOf(sql: string): { query: string; tables: string[] } | null {
  let s = shapes.get(sql);
  if (s !== undefined) return s;
  s = IGNORED.test(sql) ? null : { query: normalise(sql), tables: tablesOf(sql) };
  // Unparameterised SQL (inlined literals) would grow this without bound.
  if (shapes.size >= MAX_SHAPES) shapes.clear();
  shapes.set(sql, s);
  return s;
}

function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === "object") {
    const r = result as { records?: unknown[]; affected?: number; affectedRows?: number };
    if (Array.isArray(r.records)) return r.records.length;
  }
  return 0;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export class QueryInsights {
  private groups = new Map<string, InsightQuery>();
  private since = Date.now();
  private total = 0;
  public enabled = false;

  constructor(private readonly dataSource: DataSource) {}

  /** The one recorder for this DataSource; every Studio dispatcher shares it. */
  static shared(dataSource: DataSource): QueryInsights {
    const driver = dataSource.driver as unknown as { [RECORDER]?: QueryInsights };
    return (driver[RECORDER] ??= new QueryInsights(dataSource).install());
  }

  /** Patch the driver so every QueryRunner it hands out is timed. Idempotent. */
  install() {
    const driver = this.dataSource.driver as unknown as {
      createQueryRunner: (mode: string) => QueryRunner;
      [WRAPPED]?: boolean;
      [RECORDER]?: QueryInsights;
    };
    driver[RECORDER] ??= this;
    if (driver[WRAPPED]) return this;
    const original = driver.createQueryRunner.bind(driver);
    driver.createQueryRunner = (mode: string) => wrapRunner(original(mode), () => driver[RECORDER]);
    driver[WRAPPED] = true;
    return this;
  }

  record(sql: string, ms: number, rows: number, error: string | null) {
    // Transaction control and session settings are noise.
    const shape = shapeOf(sql);
    if (!shape) return;
    this.total++;
    const source = studioContext.getStore()?.studio ? "studio" : "app";
    const query = shape.query;
    const key = source + ":" + query;
    let g = this.groups.get(key);
    if (!g) {
      if (this.groups.size >= MAX_GROUPS) {
        // evict least recently seen
        let oldest: string | null = null;
        let t = Infinity;
        for (const [k, v] of this.groups) if (v.lastSeen < t) (t = v.lastSeen), (oldest = k);
        if (oldest) this.groups.delete(oldest);
      }
      g = {
        id: hash(key),
        query,
        source,
        count: 0,
        duration: 0,
        minDurationMs: Infinity,
        maxDurationMs: 0,
        rowsReturned: 0,
        errors: 0,
        tables: shape.tables,
        lastSeen: 0,
        lastError: null,
      };
      this.groups.set(key, g);
    }
    g.count++;
    g.duration += ms;
    g.minDurationMs = Math.min(g.minDurationMs, ms);
    g.maxDurationMs = Math.max(g.maxDurationMs, ms);
    g.rowsReturned += rows;
    g.lastSeen = Date.now();
    if (error) {
      g.errors++;
      g.lastError = error;
    }
  }

  snapshot(opts: { since?: number; limit?: number; includeStudio?: boolean } = {}): InsightsSnapshot {
    const queries = [...this.groups.values()]
      .filter((q) => (opts.includeStudio ?? false) || q.source === "app")
      .filter((q) => !opts.since || q.lastSeen >= opts.since)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, Math.min(opts.limit ?? 200, MAX_GROUPS))
      .map((q) => ({
        ...q,
        duration: Math.round(q.duration * 100) / 100,
        minDurationMs: Math.round((q.minDurationMs === Infinity ? 0 : q.minDurationMs) * 100) / 100,
        maxDurationMs: Math.round(q.maxDurationMs * 100) / 100,
      }));
    return { generatedAt: Date.now(), since: this.since, totalQueries: this.total, queries };
  }

  reset() {
    this.groups.clear();
    this.total = 0;
    this.since = Date.now();
  }
}

/**
 * Record an operation that does not go through a QueryRunner (MongoDB) in the
 * current Studio request's Console log.
 */
export function logStudioOperation(text: string, ms: number, error: string | null) {
  capture(text, [], ms, error);
}

function capture(sql: string, parameters: unknown, ms: number, error: string | null) {
  const log = studioContext.getStore()?.log;
  if (!log || log.length >= MAX_CAPTURED) return;
  if (/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|SAVEPOINT|RELEASE)/i.test(sql)) return;
  log.push({
    sql,
    parameters: Array.isArray(parameters)
      ? parameters.map((p) => (p instanceof Date ? p.toISOString() : Buffer.isBuffer(p) ? "<binary>" : typeof p === "bigint" ? p.toString() : p))
      : [],
    durationMs: Math.round(ms * 100) / 100,
    error,
  });
}

function wrapRunner(runner: QueryRunner, recorder: () => QueryInsights | undefined): QueryRunner {
  const r = runner as QueryRunner & { [WRAPPED]?: boolean };
  if (r[WRAPPED]) return runner;
  const original = r.query.bind(r) as (...args: unknown[]) => Promise<unknown>;
  (r as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
    const started = performance.now();
    try {
      const result = await original(...args);
      const ms = performance.now() - started;
      capture(String(args[0]), args[1], ms, null);
      const rec = recorder();
      if (rec?.enabled) rec.record(String(args[0]), ms, rowCount(result), null);
      return result;
    } catch (e) {
      const ms = performance.now() - started;
      capture(String(args[0]), args[1], ms, (e as Error).message);
      const rec = recorder();
      if (rec?.enabled) rec.record(String(args[0]), ms, 0, (e as Error).message);
      throw e;
    }
  };
  r[WRAPPED] = true;
  return runner;
}
