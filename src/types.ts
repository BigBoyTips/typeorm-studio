/**
 * Wire contract between the Studio UI and the backend ("BFF").
 *
 * Modelled on the contract recovered from @prisma/studio-core
 * (Adapter: introspect / query / insert / update / delete / raw, with
 * FilterGroup trees, SortOrderItem lists and a filtered row count),
 * but introspection is driven by TypeORM entity metadata instead of the
 * database catalog, so entity names and relations are first-class.
 */

export type DataTypeGroup =
  | "string"
  | "numeric"
  | "boolean"
  | "datetime"
  | "time"
  | "json"
  | "enum"
  | "binary"
  | "raw";

export interface StudioColumn {
  /** Database column name (rows are keyed by this). */
  name: string;
  /** Entity property path, e.g. `profile.bio` for embedded columns. */
  propertyPath: string;
  type: string;
  /** The database's own name for the type (int4, varchar, timestamp…), as Prisma Studio shows it. */
  dbType: string;
  group: DataTypeGroup;
  isArray: boolean;
  nullable: boolean;
  isPrimary: boolean;
  isGenerated: boolean;
  generationStrategy: string | null;
  /** Created/updated/deleted-date, version or generated columns are filled by TypeORM. */
  isManaged: boolean;
  defaultValue: string | null;
  enumValues: string[];
  length: string | null;
  /** Foreign key target when this column is a relation join column. */
  fk: { entity: string; column: string; relation: string } | null;
}

export type RelationKind = "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";

export interface StudioRelation {
  name: string;
  kind: RelationKind;
  target: string;
  /** Owning-side join columns living in this table: local column -> target column. */
  joinColumns: { column: string; referencedColumn: string }[];
  /**
   * For inverse sides (one-to-many / inverse one-to-one): the columns in the
   * target table that point back at this table.
   */
  inverseJoinColumns: { column: string; referencedColumn: string }[];
  /** For many-to-many: junction entity and its columns. */
  junction: {
    entity: string;
    ownerColumns: { column: string; referencedColumn: string }[];
    inverseColumns: { column: string; referencedColumn: string }[];
  } | null;
}

export interface StudioTable {
  /** Entity name — the stable id used by the UI. */
  id: string;
  tableName: string;
  schema: string | null;
  kind: "entity" | "view" | "junction" | "closure";
  readOnly: boolean;
  primaryKeys: string[];
  columns: StudioColumn[];
  relations: StudioRelation[];
}

export interface IntrospectResult {
  driver: string;
  database: string | null;
  tables: StudioTable[];
  filterOperators: FilterOperator[];
}

export type FilterOperator =
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "is null"
  | "is not null"
  | "contains"
  | "not contains"
  | "starts with"
  | "ends with"
  | "like"
  | "in";

export interface ColumnFilter {
  kind: "ColumnFilter";
  id: string;
  column: string;
  operator: FilterOperator;
  value: unknown;
  after: "and" | "or";
}

/** Raw SQL predicate, e.g. `"views" > 100 AND "title" LIKE 'A%'` (disabled in read-only mode). */
export interface SqlFilter {
  kind: "SqlFilter";
  id: string;
  sql: string;
  after: "and" | "or";
}

export interface FilterGroup {
  kind: "FilterGroup";
  id: string;
  filters: (ColumnFilter | FilterGroup | SqlFilter)[];
  after: "and" | "or";
}

export interface SortOrderItem {
  column: string;
  direction: "asc" | "desc";
}

export interface QueryDetails {
  table: string;
  pageIndex: number;
  pageSize: number;
  sortOrder?: SortOrderItem[];
  filter?: FilterGroup;
  search?: string;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  filteredRowCount: number;
  sql: string;
  durationMs: number;
}

export type StudioRequest =
  | { procedure: "introspect" }
  | { procedure: "count"; tables?: string[] }
  | ({ procedure: "query" } & QueryDetails)
  | { procedure: "insert"; table: string; rows: Record<string, unknown>[] }
  | {
      procedure: "update";
      table: string;
      updates: { row: Record<string, unknown>; changes: Record<string, unknown> }[];
    }
  | { procedure: "delete"; table: string; rows: Record<string, unknown>[] }
  | { procedure: "raw"; sql: string }
  | { procedure: "sql-schema" }
  | { procedure: "sql-lint"; sql: string }
  | { procedure: "insights"; since?: number; limit?: number; includeStudio?: boolean; reset?: boolean }
  | { procedure: "schema-diff" }
  | { procedure: "migrations" }
  | { procedure: "ai"; prompt: string; mode: "filter" | "sql" | "auto"; table?: string; sql?: string };

export interface StudioQueryLogEntry {
  sql: string;
  parameters: unknown[];
  durationMs: number;
  error: string | null;
}

export type StudioResponse<T = unknown> =
  | { ok: true; result: T; queries?: StudioQueryLogEntry[] }
  | { ok: false; error: { name: string; message: string; query?: string }; queries?: StudioQueryLogEntry[] };
