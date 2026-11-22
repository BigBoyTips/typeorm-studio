// Run with: npm run build && npm test
require("reflect-metadata");
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DataSource, EntitySchema } = require("typeorm");
const { createStudioDispatcher } = require("../dist");
const { splitStatements } = require("../dist/adapter");

// TEST_DB=postgres|mysql|mariadb|mssql runs the same suite against a live server (see CONTRIBUTING.md, "Tests").
// MongoDB has its own suite (test/mongo.test.js).
const DB = process.env.TEST_DB || "sqlite";
const CONNECTIONS = {
  sqlite: { type: "better-sqlite3", database: ":memory:" },
  postgres: { type: "postgres", url: process.env.PG_URL || "postgres://postgres@127.0.0.1:5433/studio" },
  mysql: { type: "mysql", url: process.env.MYSQL_URL || "mysql://studio:studio@127.0.0.1:3307/studio" },
  mariadb: { type: "mariadb", url: process.env.MARIADB_URL || process.env.MYSQL_URL || "mysql://studio:studio@127.0.0.1:3307/studio" },
  mssql: (() => {
    // TypeORM's mssql driver takes no `url`, so split it here.
    const u = new URL(process.env.MSSQL_URL || "mssql://sa:Studio_Pass1@127.0.0.1:14330/studio");
    return {
      type: "mssql",
      host: u.hostname,
      port: Number(u.port || 1433),
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.slice(1),
      options: { trustServerCertificate: true },
    };
  })(),
};
const DIALECT = { sqlite: "sqlite", postgres: "postgresql", mysql: "mysql", mariadb: "mariadb", mssql: "mssql" }[DB];
const Author = new EntitySchema({
  name: "Author",
  columns: {
    id: { type: Number, primary: true, generated: true },
    name: { type: String },
    kind: { type: "simple-enum", enum: ["human", "bot"], default: "human" },
    meta: { type: "simple-json", nullable: true },
  },
  relations: { books: { type: "one-to-many", target: "Book", inverseSide: "author" } },
});
const Book = new EntitySchema({
  name: "Book",
  columns: {
    id: { type: Number, primary: true, generated: true },
    title: { type: String },
    pages: { type: "integer", default: 0 },
    published: { type: Boolean, default: false },
    created: { type: DB === "postgres" ? "timestamp" : "datetime", createDate: true },
  },
  relations: { author: { type: "many-to-one", target: "Author", inverseSide: "books", nullable: true, onDelete: "SET NULL" } },
});

let ds, call;
before(async () => {
  ds = new DataSource({ ...CONNECTIONS[DB], entities: [Author, Book], synchronize: true, dropSchema: true });
  await ds.initialize();
  const d = createStudioDispatcher(ds);
  call = async (req) => {
    const r = await d(req);
    if (!r.ok) throw Object.assign(new Error(r.error.message), r.error);
    return r.result;
  };
  const a = await ds.getRepository("Author").save([{ name: "Ann" }, { name: "Bob_%", kind: "bot" }]);
  await ds.getRepository("Book").save(
    Array.from({ length: 30 }, (_, i) => ({ title: `Book ${i}`, pages: i * 10, published: i % 2 === 0, author: a[i % 2] })),
  );
});
after(() => ds.destroy());

const f = (column, operator, value, after = "and") => ({ kind: "ColumnFilter", id: column, column, operator, value, after });
const g = (filters, after = "and") => ({ kind: "FilterGroup", id: "g", after, filters });

test("introspect exposes entities, FK join columns and relations", async () => {
  const r = await call({ procedure: "introspect" });
  const book = r.tables.find((t) => t.id === "Book");
  assert.deepEqual(book.primaryKeys, ["id"]);
  const fk = book.columns.find((c) => c.name === "authorId");
  assert.deepEqual(fk.fk, { entity: "Author", column: "id", relation: "author" });
  const author = r.tables.find((t) => t.id === "Author");
  assert.equal(author.columns.find((c) => c.name === "kind").group, "enum");
  assert.deepEqual(author.relations[0].inverseJoinColumns, [{ column: "authorId", referencedColumn: "id" }]);
});

test("query pages with a stable order and reports filtered count", async () => {
  const r = await call({ procedure: "query", table: "Book", pageIndex: 2, pageSize: 7 });
  assert.equal(r.filteredRowCount, 30);
  assert.deepEqual(r.rows.map((x) => x.id), [15, 16, 17, 18, 19, 20, 21]);
});

test("sorting, nested groups and AND/OR joiners", async () => {
  const filter = g([f("published", "=", true), g([f("pages", ">=", 200, "or"), f("pages", "<", 30)])]);
  const r = await call({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 50, filter, sortOrder: [{ column: "pages", direction: "desc" }] });
  const pages = r.rows.map((x) => x.pages);
  assert.deepEqual(pages, [280, 260, 240, 220, 200, 20, 0]);
});

test("contains is case-insensitive and escapes LIKE wildcards", async () => {
  const a = await call({ procedure: "query", table: "Author", pageIndex: 0, pageSize: 10, filter: g([f("name", "contains", "_%")]) });
  assert.deepEqual(a.rows.map((x) => x.name), ["Bob_%"]);
  const b = await call({ procedure: "query", table: "Author", pageIndex: 0, pageSize: 10, filter: g([f("name", "contains", "ANN")]) });
  assert.equal(b.filteredRowCount, 1);
  // SQL Server reads [a-z] as a character class unless escaped
  const c = await call({ procedure: "query", table: "Author", pageIndex: 0, pageSize: 10, filter: g([f("name", "contains", "[a-z]")]) });
  assert.equal(c.filteredRowCount, 0);
});

test("in / is null / search", async () => {
  const r = await call({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 50, filter: g([f("id", "in", "1, 2, 3")]) });
  assert.equal(r.filteredRowCount, 3);
  const n = await call({ procedure: "query", table: "Author", pageIndex: 0, pageSize: 50, filter: g([f("meta", "is null")]) });
  assert.equal(n.filteredRowCount, 2);
  const s = await call({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 50, search: "book 2" });
  assert.equal(s.filteredRowCount, 11); // Book 2, Book 20..29
});

test("rejects unknown columns and entities (no SQL injection through identifiers)", async () => {
  await assert.rejects(call({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 5, sortOrder: [{ column: "id;drop", direction: "asc" }] }), /Unknown column/);
  await assert.rejects(call({ procedure: "query", table: "sqlite_master", pageIndex: 0, pageSize: 5 }), /Unknown entity/);
});

test("insert through FK column, update, set relation null, delete", async () => {
  const ins = await call({ procedure: "insert", table: "Book", rows: [{ title: "New", pages: "12", authorId: "2" }] });
  const row = ins.rows[0];
  assert.equal(row.title, "New");
  assert.equal(row.pages, 12);
  assert.equal(row.authorId, 2);
  assert.ok(row.created, "managed createDate column filled");

  const up = await call({ procedure: "update", table: "Book", updates: [{ row: { id: row.id }, changes: { authorId: null, published: "true" } }] });
  assert.equal(up.rows[0].authorId, null);
  assert.equal(up.rows[0].published, true);

  await call({ procedure: "update", table: "Author", updates: [{ row: { id: 1 }, changes: { meta: '{"a":1}' } }] });
  const a = await ds.getRepository("Author").findOneBy({ id: 1 });
  assert.deepEqual(a.meta, { a: 1 });

  await assert.rejects(call({ procedure: "update", table: "Book", updates: [{ row: { id: row.id }, changes: { pages: "x" } }] }), /not a number/);
  const del = await call({ procedure: "delete", table: "Book", rows: [{ id: row.id }] });
  assert.equal(del.affected, 1);
  await assert.rejects(call({ procedure: "update", table: "Book", updates: [{ row: { id: row.id }, changes: { pages: 1 } }] }), /no longer exists/);
});

test("read-only mode blocks writes and raw SQL", async () => {
  const ro = createStudioDispatcher(ds, { readOnly: true });
  assert.equal((await ro({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 1 })).ok, true);
  assert.equal((await ro({ procedure: "raw", sql: "delete from book" })).ok, false);
  assert.equal((await ro({ procedure: "delete", table: "Book", rows: [{ id: 1 }] })).ok, false);
});

test("values are hydrated like TypeORM entities (booleans, simple-json, dates)", async () => {
  await ds.getRepository("Author").update({ id: 2 }, { meta: { tags: ["x"] } });
  const a = await call({ procedure: "query", table: "Author", pageIndex: 0, pageSize: 10, filter: g([f("id", "=", 2)]) });
  assert.deepEqual(a.rows[0].meta, { tags: ["x"] });
  const b = await call({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 1 });
  assert.equal(typeof b.rows[0].published, "boolean");
  assert.ok(b.rows[0].created instanceof Date);
});

test("boolean and date filters use the driver's storage format", async () => {
  const pub = await call({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 50, filter: g([f("published", "=", "false")]) });
  assert.equal(pub.filteredRowCount, 15);
  const recent = await call({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 50, filter: g([f("created", ">", "2000-01-01T00:00:00Z")]) });
  assert.equal(recent.filteredRowCount, 30);
  const future = await call({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 50, filter: g([f("created", ">", "2999-01-01T00:00:00Z")]) });
  assert.equal(future.filteredRowCount, 0);
});

test("sql-schema lists tables and columns for autocomplete", async () => {
  const r = await call({ procedure: "sql-schema" });
  assert.equal(r.dialect, DIALECT);
  assert.ok(r.namespace.book.includes("authorId"));
});

test("sql-lint reports syntax and unknown-table errors with positions, and passes valid SQL", async () => {
  const ok = await call({ procedure: "sql-lint", sql: "select * from book;\nselect id from author" });
  assert.deepEqual(ok.diagnostics, []);
  const sql = "select * from book;\nselect * fromm author";
  const bad = await call({ procedure: "sql-lint", sql });
  assert.equal(bad.diagnostics.length, 1);
  assert.match(bad.diagnostics[0].message, /syntax/i);
  assert.ok(bad.diagnostics[0].from > sql.indexOf(";"), "points into the second statement");
  const missing = await call({ procedure: "sql-lint", sql: "select * from nope" });
  assert.match(missing.diagnostics[0].message, /no such table|does not exist|doesn't exist|Invalid object name/);
  // lint never executes
  await call({ procedure: "sql-lint", sql: "delete from book" });
  assert.equal(await ds.getRepository("Book").count(), 30);
});

test("splitStatements ignores semicolons in strings and comments", () => {
  const parts = splitStatements("select ';' as a; -- x;y\nselect 2; /* ; */ select 3");
  assert.deepEqual(parts.map((p) => p.text), ["select ';' as a", "-- x;y\nselect 2", "/* ; */ select 3"]);
});

test("query insights record app queries separately from Studio's own", async () => {
  await call({ procedure: "insights", reset: true });
  await ds.getRepository("Book").find({ where: { published: true } });
  await ds.getRepository("Book").find({ where: { published: false } });
  await call({ procedure: "query", table: "Author", pageIndex: 0, pageSize: 5 });
  const app = await call({ procedure: "insights" });
  const q = app.queries.find((x) => x.tables.includes("book"));
  assert.ok(q, "app query recorded");
  assert.equal(q.count, 2, "same statement shape grouped");
  assert.equal(q.rowsReturned, 30);
  assert.ok(app.queries.every((x) => x.source === "app"));
  const all = await call({ procedure: "insights", includeStudio: true });
  assert.ok(all.queries.some((x) => x.source === "studio"));
});

test("schema-diff reports in sync, then the DDL for an out-of-sync database", async () => {
  const r = await call({ procedure: "schema-diff" });
  // Opened as `type: "mysql"` against MariaDB, TypeORM alone reports `CHANGE … NULL` drift;
  // Studio diffs such servers as MariaDB, so every database must report a clean sync.
  assert.deepEqual(r.up.map((q) => q.query), []);
  assert.equal(r.inSync, true);
  assert.ok(!r.up.some((q) => /pages/.test(q.query)));
  // dropColumn also drops the column's DEFAULT constraint, which SQL Server requires first
  const qr = ds.createQueryRunner();
  try {
    await qr.dropColumn("book", "pages");
  } finally {
    await qr.release();
  }
  const drift = await call({ procedure: "schema-diff" });
  assert.equal(drift.inSync, false);
  assert.ok(drift.up.some((q) => /pages/.test(q.query)));
  await ds.synchronize();
  const m = await call({ procedure: "migrations" });
  assert.equal(m.configured, false);
});

test("unknown procedures are rejected", async () => {
  const r = await (createStudioDispatcher(ds))({ procedure: "ai", prompt: "books" });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /Unknown procedure "ai"/);
  const meta = await call({ procedure: "introspect" });
  assert.equal("ai" in meta.capabilities, false);
});

test("full-table search runs under the dialect's guardrails", async () => {
  const r = await call({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 5, search: "book 1" });
  assert.equal(r.filteredRowCount, 11); // Book 1, Book 10..19
  assert.equal(r.rows.length, 5);
});

test("every dispatcher on a DataSource shares one insights recorder", async () => {
  const second = createStudioDispatcher(ds);
  await call({ procedure: "insights", reset: true });
  await ds.getRepository("Author").find();
  const viaFirst = await call({ procedure: "insights" });
  const viaSecond = (await second({ procedure: "insights" })).result;
  assert.ok(viaFirst.queries.some((q) => q.tables.includes("author")));
  assert.equal(viaSecond.totalQueries, viaFirst.totalQueries);
});

test("responses carry the SQL each operation ran (Console view)", async () => {
  const d = createStudioDispatcher(ds);
  const r = await d({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 3, filter: g([f("pages", ">", 100)]) });
  assert.equal(r.ok, true);
  assert.ok(r.queries.length >= 2, "select + count");
  assert.ok(r.queries.some((q) => /COUNT\(\*\)/i.test(q.sql)));
  assert.ok(r.queries.every((q) => Array.isArray(q.parameters) && typeof q.durationMs === "number"));
  const bad = await d({ procedure: "raw", sql: "select * from nope" });
  assert.equal(bad.ok, false);
  assert.ok(bad.queries[0].error, "failed statement is logged with its error");
});

test("SQL WHERE filters combine with column filters; single expression only; off in read-only", async () => {
  const esc = (n) => ds.driver.escape(n);
  // (pages was reset by the drift test, so filter on id: ids 1-30, published when id is odd)
  const sqlF = { kind: "SqlFilter", id: "s", sql: `${esc("id")} >= 25`, after: "and" };
  const r = await call({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 50, filter: g([sqlF, f("published", "=", true)]) });
  assert.deepEqual(r.rows.map((x) => x.id).sort((a, b) => a - b), [25, 27, 29]);
  await assert.rejects(call({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 5, filter: g([{ ...sqlF, sql: "1=1; delete from book" }]) }), /single expression/);
  const ro = createStudioDispatcher(ds, { readOnly: true });
  const denied = await ro({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 5, filter: g([sqlF]) });
  assert.equal(denied.ok, false);
  assert.match(denied.error.message, /read-only/);
});

test("HTTP: only same-origin JSON requests reach the API; foreign Host headers are refused", async () => {
  const { startStudio } = require("../dist");
  const server = await startStudio(ds, { port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const http = require("http");
  const req = (opts, body) =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api", ...opts }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      });
      r.on("error", reject);
      r.end(body);
    });
  const json = JSON.stringify({ procedure: "count" });
  try {
    const ok = await req({ headers: { "content-type": "application/json" } }, json);
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).ok, true);
    // a cross-site page can send text/plain without a CORS preflight: must be refused
    assert.equal((await req({ headers: { "content-type": "text/plain" } }, json)).status, 415);
    assert.equal((await req({ headers: { "content-type": "application/json", origin: "https://evil.example" } }, json)).status, 403);
    assert.equal((await req({ headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" } }, json)).status, 403);
    assert.equal((await req({ headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" } }, json)).status, 200);
    // DNS rebinding: a foreign hostname resolving to 127.0.0.1
    assert.equal((await req({ headers: { "content-type": "application/json", host: `evil.example:${port}` } }, json)).status, 403);
    assert.equal((await req({ method: "GET", path: "/", headers: { host: `evil.example:${port}` } })).status, 403);
    assert.equal((await req({ method: "GET", path: "/", headers: { host: `localhost:${port}` } })).status, 200);
    // static files never escape the UI folder
    const trav = await req({ method: "GET", path: "/../package.json" });
    assert.ok(!trav.body.includes('"name": "typeorm-studio"'));
    const vendor = await req({ method: "GET", path: "/vendor/codemirror.js" });
    assert.equal(vendor.status, 200);
  } finally {
    server.close();
  }
});

test("lint never sends text that could hold a second statement; SQL filters refuse ';'", async () => {
  const before = await ds.getRepository("Book").count();
  // On Postgres (standard strings) 'a\' ends at the backslash, so a naive split would hide the DELETE.
  const r = await call({ procedure: "sql-lint", sql: "select 'a\\'; delete from book; --'" });
  assert.ok(Array.isArray(r.diagnostics));
  assert.equal(await ds.getRepository("Book").count(), before);
  await assert.rejects(
    call({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 1, filter: g([{ kind: "SqlFilter", id: "x", sql: "1=1; delete from book", after: "and" }]) }),
    /without ';'/,
  );
  await assert.rejects(
    call({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 1, filter: g([{ kind: "SqlFilter", id: "x", sql: "1=1) or (1=1 -- ", after: "and" }]) }),
    /comments/,
  );
  const quoted = await call({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 1, filter: g([{ kind: "SqlFilter", id: "x", sql: "'a--b' = 'a--b'", after: "and" }]) });
  assert.equal(quoted.filteredRowCount, before, "comment markers inside string literals are fine");
});
