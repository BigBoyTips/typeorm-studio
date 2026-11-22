import { Brackets as OwnBrackets, DataSource, EntityMetadata, ObjectLiteral, QueryRunner, SelectQueryBuilder, WhereExpressionBuilder } from "typeorm";
import type { ColumnMetadata } from "typeorm/metadata/ColumnMetadata";
import type { RelationMetadata } from "typeorm/metadata/RelationMetadata";
import type {
  ColumnFilter,
  SqlFilter,
  DataTypeGroup,
  FilterGroup,
  FilterOperator,
  IntrospectResult,
  QueryDetails,
  QueryResult,
  StudioColumn,
  StudioRelation,
  StudioTable,
} from "./types";

export class StudioError extends Error {
  constructor(message: string, public query?: string) {
    super(message);
    this.name = "StudioError";
  }
}

export const FILTER_OPERATORS: FilterOperator[] = [
  "=", "!=", ">", ">=", "<", "<=", "is null", "is not null",
  "contains", "not contains", "starts with", "ends with", "like", "in",
];

export const MAX_PAGE_SIZE = 1000;
/** Same budgets Prisma Studio uses for full-table search. */
export const SEARCH_TIMEOUT_MS = 5000;
export const SEARCH_LOCK_TIMEOUT_MS = 100;
export const SEARCH_TIMEOUT_MESSAGE = `Search took longer than ${SEARCH_TIMEOUT_MS / 1000}s and was cancelled. Narrow it with filters.`;

/**
 * TypeORM checks `instanceof Brackets` internally, so we must construct Brackets
 * from the *project's* typeorm copy, not ours (they differ when run through npx).
 */
const Brackets: typeof OwnBrackets = (() => {
  try {
    return require(require.resolve("typeorm", { paths: [process.cwd()] })).Brackets ?? OwnBrackets;
  } catch {
    return OwnBrackets;
  }
})();
const ALIAS = "t";

/* ------------------------------------------------------------------ */
/* Type normalisation                                                  */
/* ------------------------------------------------------------------ */

export function typeName(column: ColumnMetadata): string {
  const t = column.type as unknown;
  if (typeof t === "function") return (t as { name: string }).name.toLowerCase();
  return String(t).toLowerCase();
}

/** Same idea as Prisma Studio's datatype→group table, but over TypeORM's type vocabulary. */
export function typeGroup(type: string, column: ColumnMetadata): DataTypeGroup {
  if (column.enum && column.enum.length) return "enum";
  if (/^(bool|boolean|bit)$/.test(type)) return "boolean";
  if (/(json|simple-json|hstore)/.test(type)) return "json";
  if (/^(date|datetime|datetime2|datetimeoffset|timestamp|timestamptz|timestamp with(out)? time zone|smalldatetime)$/.test(type))
    return "datetime";
  if (/^(time|timetz|time with(out)? time zone)$/.test(type)) return "time";
  if (/(int|integer|number|numeric|decimal|float|double|real|money|serial|dec|fixed)/.test(type)) return "numeric";
  if (/(blob|bytea|binary|varbinary|image|raw)/.test(type)) return "binary";
  if (/(char|text|string|uuid|clob|citext|nvarchar|simple-array|simple-enum|enum|set|xml|cidr|inet|macaddr)/.test(type))
    return type.includes("enum") ? "enum" : "string";
  return "raw";
}

export function stringifyDefault(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "function") {
    try {
      return String((value as () => unknown)());
    } catch {
      return "fn()";
    }
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** typeName/typeGroup are regex-heavy and metadata is immutable, so classify each column once. */
const columnTypes = new WeakMap<ColumnMetadata, { name: string; group: DataTypeGroup }>();
function columnType(c: ColumnMetadata): { name: string; group: DataTypeGroup } {
  let t = columnTypes.get(c);
  if (!t) {
    const name = typeName(c);
    t = { name, group: typeGroup(name, c) };
    columnTypes.set(c, t);
  }
  return t;
}

function joinPairs(columns: ColumnMetadata[]) {
  return columns.map((c) => ({
    column: c.databaseName,
    referencedColumn: c.referencedColumn?.databaseName ?? "",
  }));
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export class TypeormStudioAdapter {
  private introspected?: IntrospectResult;
  private schemaCache?: ReturnType<TypeormStudioAdapter["buildSqlSchema"]>;
  private byName?: Map<string, EntityMetadata>;

  constructor(private readonly dataSource: DataSource) {}

  /* ---------- introspection (entity metadata, not catalog) ---------- */

  /** Entity metadata is fixed once the DataSource is initialised, so this is computed once. */
  introspect(): IntrospectResult {
    return (this.introspected ??= this.buildIntrospection());
  }

  private buildIntrospection(): IntrospectResult {
    const ds = this.dataSource;
    const tables = ds.entityMetadatas
      .map((m) => this.describe(m))
      .sort((a, b) => a.id.localeCompare(b.id));
    const opts = ds.options as { database?: unknown };
    return {
      driver: ds.options.type,
      database: typeof opts.database === "string" ? opts.database : null,
      tables,
      filterOperators: FILTER_OPERATORS,
    };
  }

  private describe(m: EntityMetadata): StudioTable {
    const kind: StudioTable["kind"] =
      m.tableType === "view" ? "view" : m.isJunction ? "junction" : m.tableType === "closure-junction" ? "closure" : "entity";
    return {
      id: m.name,
      tableName: m.tableName,
      schema: m.schema ?? null,
      kind,
      readOnly: kind === "view" || m.primaryColumns.length === 0,
      primaryKeys: m.primaryColumns.map((c) => c.databaseName),
      columns: m.columns.map((c) => this.describeColumn(c)),
      relations: m.relations.map((r) => this.describeRelation(r)),
    };
  }

  private describeColumn(c: ColumnMetadata): StudioColumn {
    const { name: type, group } = columnType(c);
    const rel = c.relationMetadata;
    return {
      name: c.databaseName,
      propertyPath: c.propertyPath,
      type,
      dbType: this.dbType(c),
      group,
      isArray: c.isArray || type === "simple-array",
      nullable: c.isNullable,
      isPrimary: c.isPrimary,
      isGenerated: c.isGenerated,
      generationStrategy: c.generationStrategy ?? null,
      isManaged: c.isCreateDate || c.isUpdateDate || c.isDeleteDate || c.isVersion || c.isGenerated,
      defaultValue: stringifyDefault(c.default),
      enumValues: (c.enum ?? []).map(String),
      length: c.length ? String(c.length) : null,
      fk:
        rel && c.referencedColumn
          ? {
              // referencedColumn's owner is right for both plain FKs and junction columns
              entity: c.referencedColumn.entityMetadata.name,
              column: c.referencedColumn.databaseName,
              relation: rel.propertyName,
            }
          : null,
    };
  }

  /** Short database type name (Postgres udt-style abbreviations, like Prisma Studio shows). */
  private dbType(c: ColumnMetadata): string {
    let t: string;
    try {
      t = String(this.dataSource.driver.normalizeType(c)).toLowerCase();
    } catch {
      return typeName(c);
    }
    const pg: Record<string, string> = {
      integer: "int4", int: "int4", smallint: "int2", bigint: "int8", "character varying": "varchar", character: "bpchar",
      boolean: "bool", "double precision": "float8", real: "float4",
      "timestamp without time zone": "timestamp", "timestamp with time zone": "timestamptz",
      "time without time zone": "time", "time with time zone": "timetz",
    };
    const d = this.dataSource.options.type;
    if (d === "postgres" || d === "cockroachdb" || d === "aurora-postgres") {
      if (t === "enum" || t === "simple-enum") return c.enumName || `${c.entityMetadata.tableName}_${c.databaseName}_enum`;
      return pg[t] ?? t;
    }
    return t;
  }

  private describeRelation(r: RelationMetadata): StudioRelation {
    const inverse = r.inverseRelation;
    return {
      name: r.propertyPath,
      kind: r.relationType,
      target: r.inverseEntityMetadata.name,
      joinColumns: r.isOwning && !r.isManyToMany ? joinPairs(r.joinColumns) : [],
      inverseJoinColumns: !r.isOwning && inverse && !r.isManyToMany ? joinPairs(inverse.joinColumns) : [],
      junction: r.isManyToMany
        ? (() => {
            const owner = r.isOwning ? r : inverse!;
            const ownerCols = joinPairs(owner.joinColumns);
            const invCols = joinPairs(owner.inverseJoinColumns);
            return {
              entity: owner.junctionEntityMetadata!.name,
              ownerColumns: r.isOwning ? ownerCols : invCols,
              inverseColumns: r.isOwning ? invCols : ownerCols,
            };
          })()
        : null,
    };
  }

  /* ---------- helpers ---------- */

  private meta(entity: string): EntityMetadata {
    this.byName ??= new Map(this.dataSource.entityMetadatas.map((x) => [x.name, x]));
    const m = this.byName.get(entity);
    if (!m) throw new StudioError(`Unknown entity "${entity}"`);
    return m;
  }

  private column(m: EntityMetadata, name: string): ColumnMetadata {
    const c = m.findColumnWithDatabaseName(name);
    if (!c) throw new StudioError(`Unknown column "${name}" on ${m.name}`);
    return c;
  }

  private esc(name: string) {
    return this.dataSource.driver.escape(name);
  }

  private ref(column: string) {
    return `${this.esc(ALIAS)}.${this.esc(column)}`;
  }

  /** Raw (non-hydrating) select of every column keyed by its database name. */
  private baseSelect(m: EntityMetadata): SelectQueryBuilder<ObjectLiteral> {
    const qb = this.dataSource.createQueryBuilder().from(m.target, ALIAS);
    m.columns.forEach((c, i) => {
      const sel = this.ref(c.databaseName);
      if (i === 0) qb.select(sel, c.databaseName);
      else qb.addSelect(sel, c.databaseName);
    });
    return qb;
  }

  /* ---------- filtering (FilterGroup tree → Brackets) ---------- */

  private applyFilter(m: EntityMetadata, qb: WhereExpressionBuilder, group: FilterGroup, counter: { n: number }) {
    let first = true;
    group.filters.forEach((f, idx) => {
      if (f.kind === "FilterGroup" && f.filters.length === 0) return;
      if (f.kind === "SqlFilter" && !f.sql.trim()) return;
      // `after` on the *previous* item joins it to this one (Prisma Studio semantics).
      const joiner = first ? "and" : group.filters[idx - 1].after;
      first = false;
      const add = (cond: string | OwnBrackets, params?: ObjectLiteral) =>
        joiner === "or" ? qb.orWhere(cond as string, params) : qb.andWhere(cond as string, params);
      if (f.kind === "FilterGroup") add(new Brackets((inner) => this.applyFilter(m, inner, f, counter)));
      else if (f.kind === "SqlFilter") {
        const sql = (f as SqlFilter).sql.trim().replace(/;+\s*$/, "");
        if (!sql) return;
        // Strict on purpose: string-escaping rules differ between databases, so any ";" is refused.
        if (sql.includes(";")) throw new StudioError("A SQL filter must be a single expression without ';'");
        // Comments would swallow the parenthesis Studio wraps the expression in.
        if (/--|\/\*|#/.test(sql.replace(/'(?:[^']|'')*'/g, "''"))) throw new StudioError("A SQL filter can't contain comments");
        add(`(${sql})`);
      } else {
        const [sql, params] = this.condition(m, f, counter);
        add(`(${sql})`, params);
      }
    });
  }

  /** Compile one column filter to a parameterised SQL fragment. Column names are validated against metadata. */
  private condition(m: EntityMetadata, f: ColumnFilter, counter: { n: number }): [string, ObjectLiteral] {
    const col = this.column(m, f.column);
    const ref = this.ref(col.databaseName);
    const p = `p${counter.n++}`;
    const value = f.value;
    const str = value === null || value === undefined ? "" : String(value);
    // SQL Server also treats [...] as a character class in LIKE patterns.
    const special = this.dataSource.options.type === "mssql" ? /[\\%_[]/g : /[\\%_]/g;
    const likeEsc = (s: string) => s.replace(special, (ch) => "\\" + ch);
    const ilike = (pattern: string): [string, ObjectLiteral] => [
      `LOWER(${this.textCast(ref)}) LIKE LOWER(:${p})${this.escapeClause()}`,
      { [p]: pattern },
    ];
    switch (f.operator) {
      case "is null":
        return [`${ref} IS NULL`, {}];
      case "is not null":
        return [`${ref} IS NOT NULL`, {}];
      case "contains":
        return ilike(`%${likeEsc(str)}%`);
      case "not contains": {
        const [sql, params] = ilike(`%${likeEsc(str)}%`);
        return [`${ref} IS NULL OR NOT (${sql})`, params];
      }
      case "starts with":
        return ilike(`${likeEsc(str)}%`);
      case "ends with":
        return ilike(`%${likeEsc(str)}`);
      case "like":
        return [`${this.textCast(ref)} LIKE :${p}`, { [p]: str }];
      case "in": {
        const list = Array.isArray(value) ? value : str.split(",").map((s) => s.trim()).filter(Boolean);
        if (!list.length) return ["1 = 0", {}];
        return [`${ref} IN (:...${p})`, { [p]: list.map((v) => this.persist(col, this.coerce(col, v))) }];
      }
      case "=":
      case "!=":
      case ">":
      case ">=":
      case "<":
      case "<=": {
        const op = f.operator === "!=" ? "<>" : f.operator;
        return [`${ref} ${op} :${p}`, { [p]: this.persist(col, this.coerce(col, value)) }];
      }
      default:
        throw new StudioError(`Unsupported operator "${(f as ColumnFilter).operator}"`);
    }
  }

  /** MySQL/MariaDB already use backslash as the LIKE escape and treat '\\' specially in literals. */
  private escapeClause(): string {
    const t = this.dataSource.options.type;
    return t === "mysql" || t === "mariadb" || t === "aurora-mysql" ? "" : " ESCAPE '\\'";
  }

  /** Cast to text so LIKE works on non-text columns (numbers, uuids, dates). */
  private textCast(ref: string): string {
    const t = this.dataSource.options.type;
    if (t === "postgres" || t === "cockroachdb" || t === "aurora-postgres") return `CAST(${ref} AS TEXT)`;
    if (t === "mysql" || t === "mariadb" || t === "aurora-mysql") return `CAST(${ref} AS CHAR)`;
    if (t === "mssql") return `CAST(${ref} AS NVARCHAR(MAX))`;
    if (t === "oracle") return `TO_CHAR(${ref})`;
    return ref; // sqlite & friends compare loosely already
  }

  /** Full-table search: OR of `contains` over text-like columns (cf. Prisma's text-like predicates). */
  private applySearch(m: EntityMetadata, qb: SelectQueryBuilder<ObjectLiteral>, term: string, counter: { n: number }) {
    const needle = term.trim();
    if (needle.length < 1) return;
    const cols = m.columns
      .filter((c) => {
        const g = columnType(c).group;
        return g === "string" || g === "enum" || (g === "numeric" && /^-?\d+(\.\d+)?$/.test(needle)) || g === "json";
      })
      .slice(0, 64);
    if (!cols.length) return;
    qb.andWhere(
      new Brackets((inner) => {
        for (const c of cols) {
          const [sql, params] = this.condition(
            m,
            { kind: "ColumnFilter", id: "", column: c.databaseName, operator: "contains", value: needle, after: "or" },
            counter,
          );
          inner.orWhere(`(${sql})`, params);
        }
      }),
    );
  }

  /* ---------- reading ---------- */

  async query(d: QueryDetails): Promise<QueryResult> {
    const m = this.meta(d.table);
    const pageSize = Math.min(Math.max(1, Math.floor(d.pageSize) || 50), MAX_PAGE_SIZE);
    const pageIndex = Math.max(0, Math.floor(d.pageIndex) || 0);
    const counter = { n: 0 };

    const build = () => {
      const qb = this.baseSelect(m);
      if (d.filter && d.filter.filters.length) {
        qb.andWhere(new Brackets((w) => this.applyFilter(m, w, d.filter!, counter)));
      }
      if (d.search) this.applySearch(m, qb, d.search, counter);
      return qb;
    };

    const qb = build();
    for (const s of d.sortOrder ?? []) {
      const col = this.column(m, s.column);
      qb.addOrderBy(this.ref(col.databaseName), s.direction === "desc" ? "DESC" : "ASC");
    }
    // Stable pagination: fall back to primary keys.
    if (!d.sortOrder?.length) {
      for (const pk of m.primaryColumns) qb.addOrderBy(this.ref(pk.databaseName), "ASC");
    }
    qb.offset(pageIndex * pageSize).limit(pageSize);

    const countQb = build().select("COUNT(*)", "count").orderBy();

    const started = Date.now();
    try {
      const run = async (runner?: QueryRunner) => {
        if (runner) {
          qb.setQueryRunner(runner);
          countQb.setQueryRunner(runner);
          // one connection: run sequentially
          const rows = await qb.getRawMany();
          return [rows, await countQb.getRawOne<{ count: string | number }>()] as const;
        }
        return Promise.all([qb.getRawMany(), countQb.getRawOne<{ count: string | number }>()]);
      };
      const [rows, countRow] = d.search?.trim() ? await this.guarded(run) : await run();
      return {
        rows: rows.map((r) => this.hydrate(m, r)),
        filteredRowCount: Number(countRow?.count ?? 0),
        sql: qb.getQuery(),
        durationMs: Date.now() - started,
      };
    } catch (e) {
      throw new StudioError((e as Error).message, qb.getQuery());
    }
  }

  /**
   * Full-table search guardrails (cf. Prisma's statement_timeout / lock_timeout):
   * Postgres gets SET LOCAL timeouts inside a read transaction, MySQL gets
   * MAX_EXECUTION_TIME, everything else a client-side deadline.
   */
  private async guarded<T>(fn: (runner?: QueryRunner) => Promise<T>): Promise<T> {
    const t = this.dataSource.options.type;
    const timeoutError = (e: unknown) => {
      const msg = (e as Error).message ?? "";
      if (/statement timeout|lock timeout|max_execution_time|max_statement_time|maximum statement execution time|canceling statement/i.test(msg)) {
        return new StudioError(SEARCH_TIMEOUT_MESSAGE);
      }
      return e;
    };
    if (t === "postgres" || t === "cockroachdb") {
      const runner = this.dataSource.createQueryRunner("slave");
      await runner.connect();
      try {
        await runner.startTransaction();
        await runner.query(`SET LOCAL statement_timeout = ${SEARCH_TIMEOUT_MS}`);
        await runner.query(`SET LOCAL lock_timeout = ${SEARCH_LOCK_TIMEOUT_MS}`);
        const out = await fn(runner);
        await runner.commitTransaction();
        return out;
      } catch (e) {
        if (runner.isTransactionActive) await runner.rollbackTransaction().catch(() => undefined);
        throw timeoutError(e);
      } finally {
        await runner.release();
      }
    }
    if (t === "mysql" || t === "mariadb" || t === "aurora-mysql") {
      const runner = this.dataSource.createQueryRunner("slave");
      await runner.connect();
      // MySQL knows MAX_EXECUTION_TIME (ms), MariaDB max_statement_time (s); set both, ignore the unknown one.
      const set = async (on: boolean) => {
        await runner.query(`SET SESSION MAX_EXECUTION_TIME = ${on ? SEARCH_TIMEOUT_MS : 0}`).catch(() => undefined);
        await runner.query(`SET SESSION max_statement_time = ${on ? SEARCH_TIMEOUT_MS / 1000 : 0}`).catch(() => undefined);
      };
      try {
        await set(true);
        return await fn(runner);
      } catch (e) {
        throw timeoutError(e);
      } finally {
        await set(false);
        await runner.release();
      }
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StudioError(SEARCH_TIMEOUT_MESSAGE)), SEARCH_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Convert a raw driver row into typed values the same way TypeORM hydrates
   * entities (booleans, simple-json/array, dates, column transformers).
   * Rows stay keyed by database column name.
   */
  private hydrate(m: EntityMetadata, raw: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!raw) return raw as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const c of m.columns) {
      const v = raw[c.databaseName];
      try {
        out[c.databaseName] = this.dataSource.driver.prepareHydratedValue(v, c);
      } catch {
        out[c.databaseName] = v;
      }
    }
    return out;
  }

  async count(tables?: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const metas = this.dataSource.entityMetadatas.filter((m) => !tables || tables.includes(m.name));
    await Promise.all(
      metas.map(async (m) => {
        try {
          out[m.name] = await this.dataSource.createQueryBuilder().from(m.target, ALIAS).getCount();
        } catch {
          out[m.name] = -1;
        }
      }),
    );
    return out;
  }

  /* ---------- writing (through TypeORM so subscribers/transformers run) ---------- */

  /** Turn UI input (JSON) into a value the driver/entity expects. */
  private coerce(c: ColumnMetadata, v: unknown): unknown {
    if (v === null || v === undefined) return v;
    const { name: t, group: g } = columnType(c);
    if (typeof v === "string") {
      if (g === "numeric") {
        if (/bigint|int8|decimal|numeric|money/.test(t)) return v.trim();
        const n = Number(v);
        if (v.trim() === "" || Number.isNaN(n)) throw new StudioError(`"${v}" is not a number (${c.databaseName})`);
        return n;
      }
      if (g === "boolean") return v === "true" || v === "1";
      if (g === "datetime") {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) throw new StudioError(`"${v}" is not a valid date (${c.databaseName})`);
        return t === "date" ? v.slice(0, 10) : d;
      }
      if (g === "json" && t !== "simple-json") {
        // let drivers that store json as text receive text
        return v;
      }
      if (g === "json") {
        try {
          return JSON.parse(v);
        } catch {
          throw new StudioError(`Invalid JSON for ${c.databaseName}`);
        }
      }
      if (t === "simple-array") return v.split(",");
    }
    if (g === "json" && t !== "simple-json" && typeof v === "object") {
      return this.dataSource.options.type === "postgres" ? v : JSON.stringify(v);
    }
    return v;
  }

  /** Entity-space value -> driver storage format (dates, booleans, transformers), for raw query parameters. */
  private persist(c: ColumnMetadata, v: unknown): unknown {
    if (v === null || v === undefined) return v;
    try {
      return this.dataSource.driver.preparePersistentValue(v, c);
    } catch {
      return v;
    }
  }

  /** Build an entity-shaped partial from a db-column keyed record. */
  private toEntity(m: EntityMetadata, values: Record<string, unknown>): ObjectLiteral {
    const entity: ObjectLiteral = {};
    for (const [name, raw] of Object.entries(values)) {
      const c = this.column(m, name);
      const v = this.coerce(c, raw);
      if (v === null && c.isVirtual && c.relationMetadata) {
        entity[c.relationMetadata.propertyName] = null;
      } else {
        c.setEntityValue(entity, v);
      }
    }
    return entity;
  }

  private pkWhere(m: EntityMetadata, row: Record<string, unknown>): ObjectLiteral {
    if (!m.primaryColumns.length) throw new StudioError(`${m.name} has no primary key; it is read-only in Studio`);
    const pk: Record<string, unknown> = {};
    for (const c of m.primaryColumns) {
      if (!(c.databaseName in row)) throw new StudioError(`Row is missing primary key ${c.databaseName}`);
      pk[c.databaseName] = row[c.databaseName];
    }
    return this.toEntity(m, pk);
  }

  private async reload(m: EntityMetadata, pkRow: Record<string, unknown>) {
    const qb = this.baseSelect(m);
    m.primaryColumns.forEach((c, i) => {
      const p = `pk${i}`;
      qb.andWhere(`${this.ref(c.databaseName)} = :${p}`, { [p]: this.persist(c, this.coerce(c, pkRow[c.databaseName])) });
    });
    return this.hydrate(m, await qb.getRawOne());
  }

  private assertWritable(m: EntityMetadata) {
    if (m.tableType === "view") throw new StudioError(`${m.name} is a view and cannot be modified`);
  }

  async insert(table: string, rows: Record<string, unknown>[]) {
    const m = this.meta(table);
    this.assertWritable(m);
    const inserted = await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(m.target);
      const out: Record<string, unknown>[] = [];
      for (const row of rows) {
        // "" means "empty string" for text columns (as in Prisma Studio) and "not set" for everything else
        const clean = Object.fromEntries(
          Object.entries(row).filter(([k, v]) => v !== undefined && (v !== "" || columnType(this.column(m, k)).group === "string")),
        );
        const saved = await repo.save(repo.create(this.toEntity(m, clean)));
        const pkRow: Record<string, unknown> = {};
        for (const c of m.primaryColumns) {
          const v = c.getEntityValue(saved);
          pkRow[c.databaseName] = v;
        }
        out.push(pkRow);
      }
      return out;
    });
    return { rows: await Promise.all(inserted.map((pk) => this.reload(m, pk))) };
  }

  async update(table: string, updates: { row: Record<string, unknown>; changes: Record<string, unknown> }[]) {
    const m = this.meta(table);
    this.assertWritable(m);
    await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(m.target);
      for (const u of updates) {
        if (!Object.keys(u.changes).length) continue;
        const where = this.pkWhere(m, u.row);
        const res = await repo.update(where, this.toEntity(m, u.changes));
        // MySQL reports 0 affected rows for no-op updates, so confirm before failing.
        // count(), not exist()/exists(): those are missing from early 0.3 releases and renamed in later ones.
        if (res.affected === 0 && (await repo.count({ where })) === 0) {
          throw new StudioError(`Row no longer exists in ${m.name}`);
        }
      }
    });
    const keys = updates.map((u) => {
      // primary key may itself have been edited
      const pk: Record<string, unknown> = {};
      for (const c of m.primaryColumns) pk[c.databaseName] = c.databaseName in u.changes ? u.changes[c.databaseName] : u.row[c.databaseName];
      return pk;
    });
    return { rows: await Promise.all(keys.map((k) => this.reload(m, k))) };
  }

  async delete(table: string, rows: Record<string, unknown>[]) {
    const m = this.meta(table);
    this.assertWritable(m);
    let affected = 0;
    await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(m.target);
      for (const row of rows) {
        const res = await repo.delete(this.pkWhere(m, row));
        affected += res.affected ?? 0;
      }
    });
    return { affected };
  }

  /* ---------- raw SQL console ---------- */

  async raw(sql: string) {
    const started = Date.now();
    try {
      const result = await this.dataSource.query(sql);
      const rows = Array.isArray(result) ? result.filter((r) => r && typeof r === "object" && !Array.isArray(r)) : [];
      return {
        rows,
        rowCount: Array.isArray(result) ? result.length : Number((result as { affectedRows?: number })?.affectedRows ?? 0),
        durationMs: Date.now() - started,
      };
    } catch (e) {
      throw new StudioError((e as Error).message, sql);
    }
  }

  /* ---------- SQL editor support ---------- */

  /** Tables and columns for editor autocomplete (cf. Prisma's sqlSchema / AdapterSqlSchemaResult). */
  sqlSchema() {
    return (this.schemaCache ??= this.buildSqlSchema());
  }

  private buildSqlSchema() {
    const t = this.dataSource.options.type;
    const dialect = /postgres|cockroach/.test(t)
      ? "postgresql"
      : t === "mariadb"
        ? "mariadb"
        : /mysql/.test(t)
          ? "mysql"
          : /mssql/.test(t)
            ? "mssql"
            : /sqlite|sqljs|capacitor|cordova|expo|nativescript|react-native/.test(t)
              ? "sqlite"
              : "standard";
    const namespace: Record<string, string[]> = {};
    for (const m of this.dataSource.entityMetadatas) {
      namespace[m.tablePath] = m.columns.map((c) => c.databaseName);
    }
    return { dialect, namespace, entities: Object.fromEntries(this.dataSource.entityMetadatas.map((m) => [m.name, m.tablePath])) };
  }

  /**
   * Parse/plan diagnostics without executing anything: each statement is
   * EXPLAINed (Postgres/MySQL inside a rolled-back transaction; SQLite only
   * compiles it; SQL Server returns its estimated plan under SHOWPLAN_XML).
   * Non-DML statements (DDL, PRAGMA…) are skipped.
   */
  async lint(sql: string) {
    if (sql.length > 50_000) return { diagnostics: [] };
    const t = this.dataSource.options.type;
    const supported = /postgres|cockroach|mysql|mariadb|sqlite|sqljs|mssql/.test(t);
    if (!supported) return { diagnostics: [] };
    const diagnostics: { from: number; to: number; message: string; severity: "error" }[] = [];
    const statements = splitStatements(sql).filter(
      // Never send text that could still hold a second statement (quoting rules differ per database).
      (s) => /^(select|with|insert|update|delete|values)\b/i.test(s.text.trim()) && !s.text.includes(";"),
    );
    if (!statements.length) return { diagnostics };
    const check = t === "mssql" ? await this.mssqlPlanner() : null;
    try {
      for (const stmt of statements) {
        try {
          if (check) await check.plan(stmt.text);
          else await this.explain(stmt.text, !/sqlite|sqljs/.test(t));
        } catch (e) {
          diagnostics.push(lintDiagnostic(sql, stmt, e));
        }
      }
    } finally {
      await check?.close();
    }
    return { diagnostics };
  }

  private async explain(text: string, transactional: boolean) {
    const runner = this.dataSource.createQueryRunner();
    try {
      await runner.connect();
      if (transactional) await runner.startTransaction();
      try {
        await runner.query(`EXPLAIN ${text}`);
      } finally {
        if (transactional && runner.isTransactionActive) await runner.rollbackTransaction().catch(() => undefined);
      }
    } finally {
      await runner.release().catch(() => undefined);
    }
  }

  /**
   * SQL Server has no EXPLAIN. Under SET SHOWPLAN_XML the server compiles each
   * batch (resolving tables and columns) and returns its plan instead of running it.
   * The setting has to be its own batch on one connection, but TypeORM sends every
   * query through sp_executesql, which resets session options. So this uses a
   * private one-connection pool, closed afterwards, so the app never gets a
   * connection that still has SHOWPLAN on. Each statement also runs inside a
   * transaction that is rolled back, as a second safeguard.
   */
  private async mssqlPlanner() {
    type MssqlRequest = { batch(sql: string): Promise<unknown> };
    type MssqlLib = {
      ConnectionPool: new (config: object) => { connect(): Promise<unknown>; close(): Promise<unknown> };
      Transaction: new (pool: unknown) => { begin(): Promise<unknown>; rollback(): Promise<unknown> };
      Request: new (tx: unknown) => MssqlRequest;
    };
    const driver = this.dataSource.driver as unknown as { mssql: MssqlLib; master: { config: object } };
    const pool = new driver.mssql.ConnectionPool({ ...driver.master.config, pool: { min: 0, max: 1 } });
    await pool.connect();
    return {
      plan: async (text: string) => {
        const tx = new driver.mssql.Transaction(pool);
        await tx.begin();
        try {
          await new driver.mssql.Request(tx).batch("SET SHOWPLAN_XML ON");
          try {
            await new driver.mssql.Request(tx).batch(text);
          } finally {
            await new driver.mssql.Request(tx).batch("SET SHOWPLAN_XML OFF").catch(() => undefined);
          }
        } finally {
          await tx.rollback().catch(() => undefined);
        }
      },
      close: () => pool.close().catch(() => undefined),
    };
  }
}

/** Map a database error to an editor range: by character position, line number, or the token it names. */
function lintDiagnostic(sql: string, stmt: { text: string; from: number; to: number; leading: number }, e: unknown) {
  const err = e as Error & { position?: string; lineNumber?: number; driverError?: { position?: string; lineNumber?: number } };
  const message = err.message.replace(/^SQLITE_ERROR: /, "");
  const start = stmt.from + stmt.leading;
  let from = stmt.from;
  let to = stmt.to;
  const pos = Number(err.position ?? err.driverError?.position);
  if (pos > 0) {
    // Postgres positions are 1-based within "EXPLAIN <stmt>"
    from = start + Math.max(0, pos - 1 - "EXPLAIN ".length);
    const word = /^[\w"'`.]+/.exec(sql.slice(from));
    to = from + Math.max(1, word ? word[0].length : 1);
    return { from, to, message, severity: "error" as const };
  }
  // SQL Server reports a 1-based line within the statement: search for the token from there.
  const line = Number(err.lineNumber ?? err.driverError?.lineNumber);
  let searchFrom = stmt.from;
  if (line > 1) {
    const lines = stmt.text.split("\n");
    if (line <= lines.length) {
      searchFrom = start + lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
      from = searchFrom;
      to = searchFrom + lines[line - 1].length;
    }
  }
  const near = /near "([^"]+)"|near '([^']+)|object name '([^']+)'|column name '([^']+)'/.exec(message);
  const token = near?.[1] ?? near?.[2] ?? near?.[3] ?? near?.[4];
  if (token) {
    const at = sql.indexOf(token.split("\n")[0], searchFrom);
    if (at >= 0 && at < stmt.to) {
      from = at;
      to = at + Math.max(1, Math.min(token.length, 40));
    }
  }
  return { from, to, message, severity: "error" as const };
}

/** Split on top-level semicolons, ignoring quotes and comments. Offsets refer to the input. */
export function splitStatements(sql: string): { text: string; from: number; to: number; leading: number }[] {
  const out: { text: string; from: number; to: number; leading: number }[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const raw = sql.slice(start, end);
    if (raw.trim()) {
      const leading = raw.length - raw.trimStart().length;
      out.push({ text: raw.trim(), from: start, to: end, leading });
    }
  };
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl + 1;
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) j += 2;
          else break;
        } else if (sql[j] === "\\" && ch !== '"') j += 2;
        else j++;
      }
      i = j + 1;
    } else if (ch === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end < 0 ? sql.length : end + tag[0].length;
      } else i++;
    } else if (ch === ";") {
      push(i);
      start = i + 1;
      i++;
    } else i++;
  }
  push(sql.length);
  return out;
}
