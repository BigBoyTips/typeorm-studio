import { DataSource, MigrationExecutor } from "typeorm";
import type { DataSourceOptions } from "typeorm";

const mariaDbServer = new WeakMap<DataSource, Promise<boolean>>();

/** A `type: "mysql"` DataSource may point at a MariaDB server. */
function isMariaDbBehindMysql(ds: DataSource): Promise<boolean> {
  if (ds.options.type !== "mysql") return Promise.resolve(false);
  let known = mariaDbServer.get(ds);
  if (!known) {
    known = ds
      .query("SELECT VERSION() AS v")
      .then((rows: { v?: string }[]) => /mariadb/i.test(String(rows?.[0]?.v ?? "")))
      .catch(() => false);
    mariaDbServer.set(ds, known);
  }
  return known;
}

/**
 * Schema drift: TypeORM's equivalent of Prisma Studio's schema-diff view.
 * `SchemaBuilder.log()` computes, without executing, the DDL that
 * `synchronize` would run to make the database match the entities.
 */
export async function schemaDiff(ds: DataSource) {
  const started = Date.now();
  if (ds.options.type === "mongodb") {
    // MongoDB has no schema to diff (TypeORM only syncs indexes there).
    return { inSync: true, up: [], down: [], durationMs: 0, supported: false };
  }
  const sql = await logSchemaChanges(ds);
  const fmt = (q: { query: string; parameters?: unknown[] }) => ({
    query: q.query,
    parameters: q.parameters ?? [],
  });
  return {
    inSync: sql.upQueries.length === 0,
    up: sql.upQueries.map(fmt),
    down: sql.downQueries.map(fmt),
    durationMs: Date.now() - started,
    supported: true,
  };
}

/**
 * TypeORM reads MariaDB's catalog correctly only when the DataSource says
 * `type: "mariadb"`. Opened as `type: "mysql"`, it misreads `COLUMN_DEFAULT = 'NULL'`
 * (MariaDB 10.2.7+) and reports `CHANGE … NULL` and foreign-key statements for every
 * nullable column. For such servers, diff through a short-lived MariaDB-typed copy.
 */
async function logSchemaChanges(ds: DataSource) {
  if (!(await isMariaDbBehindMysql(ds))) return ds.driver.createSchemaBuilder().log();
  const shadow = new DataSource({
    ...ds.options,
    type: "mariadb",
    name: undefined,
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
    logging: false,
    poolSize: 1,
  } as DataSourceOptions);
  await shadow.initialize();
  try {
    return await shadow.driver.createSchemaBuilder().log();
  } finally {
    await shadow.destroy();
  }
}

export async function migrationStatus(ds: DataSource) {
  if (!ds.migrations.length) return { configured: false, migrations: [] as { name: string; timestamp: number; executed: boolean }[] };
  const ex = new MigrationExecutor(ds);
  const [all, executed] = await Promise.all([ex.getAllMigrations(), ex.getExecutedMigrations().catch(() => [])]);
  const done = new Set(executed.map((m) => m.name));
  return {
    configured: true,
    migrations: all
      .map((m) => ({ name: m.name, timestamp: m.timestamp, executed: done.has(m.name) }))
      .sort((a, b) => a.timestamp - b.timestamp),
  };
}
