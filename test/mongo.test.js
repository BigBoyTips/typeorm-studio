// MongoDB suite. Run with: npm run build && npm run test:mongo  (MONGO_URL defaults to mongodb://127.0.0.1:27018/studio_test)
require("reflect-metadata");
process.env.TYPEORM_STUDIO_AI = "off";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DataSource, EntitySchema } = require("typeorm");
const { createStudioDispatcher } = require("../dist");
const { parseShell } = require("../dist/mongo-shell");

const ENABLED = process.env.TEST_DB === "mongodb" || !!process.env.MONGO_URL;
const URL = process.env.MONGO_URL || "mongodb://127.0.0.1:27018/studio_test";
const skip = ENABLED ? false : "set TEST_DB=mongodb (or MONGO_URL) to run the MongoDB suite";

class Address {}
const AddressSchema = new EntitySchema({ name: "Address", target: Address, columns: { city: { type: String }, zip: { type: String, nullable: true } } });
const Book = new EntitySchema({
  name: "Book",
  columns: {
    _id: { type: "objectId", objectId: true, primary: true },
    title: { type: String },
    pages: { type: Number, default: 0 },
    published: { type: Boolean, default: false },
    kind: { type: "enum", enum: ["novel", "manual"], nullable: true },
    tags: { type: "array", nullable: true },
    meta: { type: "json", nullable: true },
    created: { type: Date, createDate: true },
    updated: { type: Date, updateDate: true },
  },
  embeddeds: { publisher: { schema: AddressSchema } },
});

let ds, call;
before(async () => {
  if (!ENABLED) return;
  ds = new DataSource({ type: "mongodb", url: URL, entities: [Book] });
  await ds.initialize();
  await ds.mongoManager.deleteMany(Book, {});
  const d = createStudioDispatcher(ds);
  call = async (req) => {
    const r = await d(req);
    if (!r.ok) throw Object.assign(new Error(r.error.message), r.error);
    return r.result;
  };
  const repo = ds.getMongoRepository(Book);
  for (let i = 0; i < 30; i++) {
    await repo.save(
      repo.create({
        title: i === 7 ? "Odd_% [title]" : `Book ${i}`,
        pages: i * 10,
        published: i % 2 === 0,
        kind: i % 3 === 0 ? "manual" : "novel",
        tags: i < 3 ? ["intro", `t${i}`] : null,
        meta: i === 1 ? { a: 1 } : null,
        publisher: { city: i % 2 ? "Oslo" : "Lima" },
      }),
    );
  }
});
after(() => ds?.destroy());

const f = (column, operator, value, after = "and") => ({ kind: "ColumnFilter", id: column, column, operator, value, after });
const g = (filters, after = "and") => ({ kind: "FilterGroup", id: "g", after, filters });
const q = (extra) => call({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 50, ...extra });

test("introspect: ObjectId key, dotted embedded paths, Mongo capabilities", { skip }, async () => {
  const r = await call({ procedure: "introspect" });
  assert.equal(r.driver, "mongodb");
  const book = r.tables.find((t) => t.id === "Book");
  assert.deepEqual(book.primaryKeys, ["_id"]);
  const id = book.columns.find((c) => c.name === "_id");
  assert.equal(id.dbType, "objectId");
  assert.equal(id.isManaged, true);
  assert.ok(book.columns.some((c) => c.name === "publisher.city"));
  assert.equal(book.columns.find((c) => c.name === "kind").group, "enum");
  assert.deepEqual(book.relations, []);
  assert.equal(r.capabilities.queryLanguage, "mongodb");
  assert.equal(r.capabilities.insights, false);
  assert.equal(r.capabilities.schemaDiff, false);
  assert.equal(r.capabilities.sqlEditor, true);
});

test("count and stable pagination by _id", { skip }, async () => {
  assert.equal((await call({ procedure: "count" })).Book, 30);
  const r = await call({ procedure: "query", table: "Book", pageIndex: 2, pageSize: 7 });
  assert.equal(r.filteredRowCount, 30);
  assert.deepEqual(r.rows.map((x) => x.pages), [140, 150, 160, 170, 180, 190, 200]);
  assert.match(r.sql, /^db\.book\.find\(/);
  assert.equal(typeof r.rows[0]._id, "object", "ObjectId (serialised to hex over HTTP)");
});

test("sorting, nested groups and AND/OR joiners (AND binds tighter)", { skip }, async () => {
  const filter = g([f("published", "=", true), g([f("pages", ">=", 200, "or"), f("pages", "<", 30)])]);
  const r = await q({ filter, sortOrder: [{ column: "pages", direction: "desc" }] });
  assert.deepEqual(r.rows.map((x) => x.pages), [280, 260, 240, 220, 200, 20, 0]);
  // a = true AND pages < 30 OR pages >= 280  →  (0, 20) + (280, 290)
  const flat = await q({ filter: g([f("published", "=", "true"), f("pages", "<", "30", "or"), f("pages", ">=", 280)]), sortOrder: [{ column: "pages", direction: "asc" }] });
  assert.deepEqual(flat.rows.map((x) => x.pages), [0, 20, 280, 290]);
});

test("text operators escape regex/LIKE characters and work on embedded and numeric fields", { skip }, async () => {
  assert.equal((await q({ filter: g([f("title", "contains", "_% [")]) })).filteredRowCount, 1);
  assert.equal((await q({ filter: g([f("title", "contains", "BOOK 2")]) })).filteredRowCount, 11);
  assert.equal((await q({ filter: g([f("title", "starts with", "odd")]) })).filteredRowCount, 1);
  assert.equal((await q({ filter: g([f("title", "ends with", "29")]) })).filteredRowCount, 1);
  assert.equal((await q({ filter: g([f("title", "like", "Book _")]) })).filteredRowCount, 9);
  assert.equal((await q({ filter: g([f("publisher.city", "=", "Oslo")]) })).filteredRowCount, 15);
  assert.equal((await q({ filter: g([f("pages", "contains", "15")]) })).filteredRowCount, 1, "numbers match by their text");
  assert.equal((await q({ filter: g([f("title", "not contains", "book")]) })).filteredRowCount, 1);
  assert.equal((await q({ filter: g([f("tags", "contains", "intro")]) })).filteredRowCount, 3, "matches array elements");
});

test("in / is null / ObjectId equality", { skip }, async () => {
  assert.equal((await q({ filter: g([f("pages", "in", "10, 20, 30")]) })).filteredRowCount, 3);
  assert.equal((await q({ filter: g([f("meta", "is null")]) })).filteredRowCount, 29);
  assert.equal((await q({ filter: g([f("meta", "is not null")]) })).filteredRowCount, 1);
  const first = (await q({})).rows[0];
  const hex = String(first._id);
  const one = await q({ filter: g([f("_id", "=", hex)]) });
  assert.equal(one.filteredRowCount, 1);
  await assert.rejects(q({ filter: g([f("_id", "=", "nope")]) }), /not a valid ObjectId/);
});

test("full-table search covers text, enum, array and (for numeric needles) number fields", { skip }, async () => {
  assert.equal((await q({ search: "book 2" })).filteredRowCount, 11);
  assert.equal((await q({ search: "MANUAL" })).filteredRowCount, 10);
  assert.equal((await q({ search: "290" })).filteredRowCount, 1);
});

test("raw filter clause takes a Mongo query document; server-side JS is refused", { skip }, async () => {
  const raw = (sql) => ({ kind: "SqlFilter", id: "s", sql, after: "and" });
  const r = await q({ filter: g([raw("{ pages: { $gte: 250 } }"), f("published", "=", true)]) });
  assert.deepEqual(r.rows.map((x) => x.pages).sort((a, b) => a - b), [260, 280]);
  await assert.rejects(q({ filter: g([raw("{ $where: 'sleep(1000)' }")]) }), /not allowed/);
  await assert.rejects(q({ filter: g([raw("[1]")]) }), /must be a document/);
  await assert.rejects(q({ filter: g([raw("{ pages: ")]) }), /Invalid Mongo filter/);
  const ro = createStudioDispatcher(ds, { readOnly: true });
  assert.equal((await ro({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 5, filter: g([raw("{}")]) })).ok, false);
});

test("insert (defaults + managed dates), update through the entity, delete", { skip }, async () => {
  const ins = await call({ procedure: "insert", table: "Book", rows: [{ _id: "", title: "New", pages: "12", "publisher.city": "Rome", tags: '["a","b"]', meta: '{ "x": 1 }' }] });
  const row = ins.rows[0];
  assert.equal(row.title, "New");
  assert.equal(row.pages, 12);
  assert.equal(row["publisher.city"], "Rome");
  assert.deepEqual(row.tags, ["a", "b"]);
  assert.deepEqual(row.meta, { x: 1 });
  assert.ok(row.created instanceof Date, "createDate filled");
  const id = String(row._id);

  await new Promise((r) => setTimeout(r, 20));
  const up = await call({ procedure: "update", table: "Book", updates: [{ row: { _id: id }, changes: { published: "true", "publisher.zip": "00100", meta: null } }] });
  assert.equal(up.rows[0].published, true);
  assert.equal(up.rows[0]["publisher.zip"], "00100");
  assert.equal(up.rows[0]["publisher.city"], "Rome", "sibling embedded field kept");
  assert.equal(up.rows[0].meta, null);
  assert.ok(up.rows[0].updated > row.updated, "updateDate bumped");

  await assert.rejects(call({ procedure: "update", table: "Book", updates: [{ row: { _id: id }, changes: { pages: "x" } }] }), /not a number/);
  await assert.rejects(call({ procedure: "update", table: "Book", updates: [{ row: { _id: id }, changes: { _id: "6b01f0aacabf4f74c55b03aa" } }] }), /can't be changed/);
  assert.equal((await call({ procedure: "delete", table: "Book", rows: [{ _id: id }] })).affected, 1);
  await assert.rejects(call({ procedure: "update", table: "Book", updates: [{ row: { _id: id }, changes: { pages: 1 } }] }), /no longer exists/);
});

test("query console runs mongosh-style commands", { skip }, async () => {
  const names = await call({ procedure: "raw", sql: "db.getCollectionNames()" });
  assert.ok(names.rows.some((r) => r.name === "book"));
  const found = await call({ procedure: "raw", sql: "db.book.find({ pages: { $lt: 30 } }, { title: 1, _id: 0 }).sort({ pages: -1 }).limit(2)" });
  assert.deepEqual(found.rows, [{ title: "Book 2" }, { title: "Book 1" }]);
  const agg = await call({ procedure: "raw", sql: `db.getCollection("book").aggregate([{ $group: { _id: "$published", n: { $sum: 1 } } }, { $sort: { _id: 1 } }])` });
  assert.deepEqual(agg.rows, [{ _id: false, n: 15 }, { _id: true, n: 15 }]);
  const cnt = await call({ procedure: "raw", sql: "// comment\ndb.book.countDocuments({ 'publisher.city': 'Lima' });" });
  assert.deepEqual(cnt.rows, [{ count: 15 }]);
  const upd = await call({ procedure: "raw", sql: "db.book.updateMany({ pages: { $gte: 280 } }, { $set: { flagged: true } })" });
  assert.equal(upd.rowCount, 2);
  const cmd = await call({ procedure: "raw", sql: "db.runCommand({ ping: 1 })" });
  assert.equal(cmd.rows[0].ok, 1);
  await assert.rejects(call({ procedure: "raw", sql: "db.book.find({}).forEach()" }), /can't follow/);
  await assert.rejects(call({ procedure: "raw", sql: "db.book.find({}).forEach(print)" }), /Unknown value "print"/);
  await assert.rejects(call({ procedure: "raw", sql: "require('fs')" }), /start with "db\."/);
  const ro = createStudioDispatcher(ds, { readOnly: true });
  assert.equal((await ro({ procedure: "raw", sql: "db.book.deleteMany({})" })).ok, false);
});

test("lint reports parse errors with positions without contacting the server", { skip }, async () => {
  assert.deepEqual((await call({ procedure: "sql-lint", sql: "db.book.find({ a: 1 })" })).diagnostics, []);
  const sql = "db.book.find({ a: 1 });\ndb.book.find({ a: })";
  const bad = await call({ procedure: "sql-lint", sql });
  assert.equal(bad.diagnostics.length, 1);
  assert.equal(sql.slice(bad.diagnostics[0].from, bad.diagnostics[0].to), "}");
  const unknown = await call({ procedure: "sql-lint", sql: "db.book.explode()" });
  assert.match(unknown.diagnostics[0].message, /Unsupported collection method/);
});

test("sql-schema lists collections and field paths; schema-diff reports unsupported", { skip }, async () => {
  const s = await call({ procedure: "sql-schema" });
  assert.equal(s.dialect, "mongodb");
  assert.ok(s.namespace.book.includes("publisher.city"));
  const diff = await call({ procedure: "schema-diff" });
  assert.equal(diff.supported, false);
});

test("Console view receives each operation as a shell command", { skip }, async () => {
  const d = createStudioDispatcher(ds);
  const r = await d({ procedure: "query", table: "Book", pageIndex: 0, pageSize: 3, filter: g([f("pages", ">", 100)]) });
  assert.equal(r.ok, true);
  assert.ok(r.queries.some((x) => /^db\.book\.find\(\{ pages: \{ \$gt: 100 \} \}\)/.test(x.sql)));
  assert.ok(r.queries.some((x) => /countDocuments/.test(x.sql)));
});

test("shell parser: literals, helpers and errors (no server needed)", () => {
  const bson = { objectId: (h) => ({ oid: h }), decimal: (s) => ({ dec: s }), long: (s) => ({ long: s }) };
  const [c] = parseShell(`db.x.find({ a: 'q"', "b c": [1, -2.5e1, true, null,], d: ObjectId("6b01f0aacabf4f74c55b03aa"), e: ISODate("2024-01-02T00:00:00Z"), r: /a\\/b/i, n: NumberLong("9") })`, bson);
  assert.equal(c.collection, "x");
  const a = c.args[0];
  assert.equal(a.a, 'q"');
  assert.deepEqual(a["b c"], [1, -25, true, null]);
  assert.deepEqual(a.d, { oid: "6b01f0aacabf4f74c55b03aa" });
  assert.equal(a.e.toISOString(), "2024-01-02T00:00:00.000Z");
  assert.equal(a.r.source, "a\\/b");
  assert.deepEqual(a.n, { long: "9" });
  assert.equal(parseShell("db.a.find()\ndb.b.find()", bson).length, 2);
  const proto = parseShell('db.x.find({ "__proto__": { polluted: 1 } })', bson)[0].args[0];
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  assert.equal(({}).polluted, undefined);
  assert.throws(() => parseShell("db.x.find({ a: process.env })", bson), /Unknown value "process"/);
  assert.throws(() => parseShell("db.x.find({ a: 'x })", bson), /Unterminated string/);
});
