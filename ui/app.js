/* TypeORM Studio UI — no framework, no build step (CodeMirror is pre-bundled in vendor/).
 *
 * Interaction model follows Prisma Studio (reverse-engineered, see docs/):
 * a navigation sidebar (Studio views + table list), a compact icon toolbar,
 * filter "pills", popover cell editors, staged edits saved with
 * "Save N rows" / "Discard edits", row selection with "copy as" and
 * "Delete N rows", pinned and sortable columns, relation arrows, a
 * paginated or infinite-scrolling grid, a Visualizer, an operations Console
 * and a SQL editor. State lives in the URL hash. */
(() => {
  "use strict";

  /* ================================================================ */
  /* utilities                                                        */
  /* ================================================================ */
  const API = "api";
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
    return n;
  };
  const ico = (name, extra = "") => el("span", { class: `ico ico-${name} ${extra}`.trim(), "aria-hidden": "true" });
  const store = {
    get(k, d) { try { const v = localStorage.getItem("typeorm-studio:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("typeorm-studio:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const uid = () => Math.random().toString(36).slice(2, 9);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  function toast(msg, isError = false) {
    const t = el("div", { class: "toast" + (isError ? " error" : ""), text: msg });
    $("#toast").append(t);
    setTimeout(() => t.remove(), isError ? 7000 : 2600);
  }

  /* ================================================================ */
  /* state                                                            */
  /* ================================================================ */
  const S = {
    meta: null,
    caps: {},
    tables: new Map(), // entity id -> table
    view: "table",
    schema: null,
    table: null, // entity id
    rows: [],
    total: 0,
    page: 0,
    size: 25,
    infinite: store.get("infinite", false),
    sort: [],
    filter: emptyGroup(),
    pills: [], // editable filter pills (draft)
    search: "",
    edits: new Map(), // row index -> { col: value }
    newRows: [],
    selected: new Set(),
    pinned: store.get("pinned", {}),
    widths: store.get("widths", {}),
    focus: null, // { r, c } display-row / visible-column indexes
    anchor: null,
    reqId: 0,
    loadingMore: false,
    log: [],
  };
  function emptyGroup() { return { kind: "FilterGroup", id: "root", after: "and", filters: [] }; }

  /* ================================================================ */
  /* API (every call is logged for the Console view)                  */
  /* ================================================================ */
  // Like Prisma Studio, the Console shows data operations; the background drift check is left out.
  const LOGGED = new Set(["introspect", "query", "insert", "update", "delete", "raw"]);
  async function call(procedure, payload = {}) {
    let body;
    try {
      const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ procedure, ...payload }) });
      body = await res.json();
    } catch (e) {
      body = { ok: false, error: { name: "NetworkError", message: "Studio server is not reachable: " + e.message } };
    }
    if (LOGGED.has(procedure)) logOp(procedure, body);
    if (!body.ok) {
      const err = new Error(body.error.message);
      err.query = body.error.query;
      throw err;
    }
    return body.result;
  }
  function logOp(procedure, body) {
    S.log.push({ id: uid(), procedure, at: new Date(), ok: body.ok, error: body.ok ? null : body.error.message, queries: body.queries || [] });
    if (S.log.length > 300) S.log.shift();
    if (S.view === "console") renderConsole(true);
  }

  /* ================================================================ */
  /* URL hash state                                                   */
  /* ================================================================ */
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    S.view = ["table", "visualizer", "console", "sql", "queries"].includes(p.get("view")) ? p.get("view") : "table";
    S.schema = p.get("schema");
    const t = p.get("table");
    S.table = t ? (findTable(t, S.schema) || {}).id || null : null;
    S.page = Math.max(0, Number(p.get("page") || 1) - 1);
    S.size = [10, 25, 50, 100, 250, 500].includes(Number(p.get("size"))) ? Number(p.get("size")) : 25;
    S.search = p.get("search") || "";
    S.sort = (p.get("sort") || "").split(",").filter(Boolean).map((s) => {
      const [column, direction] = s.split(":");
      return { column, direction: direction === "desc" ? "desc" : "asc" };
    });
    try { S.filter = p.get("filter") ? JSON.parse(p.get("filter")) : emptyGroup(); } catch { S.filter = emptyGroup(); }
  }
  function writeHash(push = false) {
    const p = new URLSearchParams();
    if (S.schema) p.set("schema", S.schema);
    if (S.table && S.view === "table") p.set("table", T().tableName);
    p.set("view", S.view);
    if (S.view === "table") {
      if (S.page && !S.infinite) p.set("page", String(S.page + 1));
      if (S.size !== 25) p.set("size", String(S.size));
      if (S.search) p.set("search", S.search);
      if (S.sort.length) p.set("sort", S.sort.map((s) => `${s.column}:${s.direction}`).join(","));
      if (S.filter.filters.length) p.set("filter", JSON.stringify(S.filter));
    }
    const hash = "#" + p.toString();
    if (hash === location.hash) return;
    if (push) history.pushState(null, "", hash);
    else history.replaceState(null, "", hash);
  }
  function findTable(name, schema) {
    const all = S.meta.tables;
    return all.find((t) => t.tableName === name && (!schema || schemaOf(t) === schema)) || all.find((t) => t.tableName === name) || all.find((t) => t.id === name);
  }

  /* ================================================================ */
  /* table helpers                                                    */
  /* ================================================================ */
  const T = () => S.tables.get(S.table);
  const isReadOnly = () => !T() || T().readOnly || S.meta.readOnly;
  const pendingRows = () => S.edits.size + S.newRows.length;
  const hasPending = () => pendingRows() > 0;
  const confirmDiscard = () => !hasPending() || confirm("You have unsaved edits. Discard them?");
  /** MongoDB: mongosh-style console and JSON filters instead of SQL. */
  const isMongo = () => (S.caps && S.caps.queryLanguage) === "mongodb";
  /** Console drafts and history are kept apart per query language. */
  const draftKey = () => (isMongo() ? "mongo-draft" : "sql-draft");
  const historyKey = () => (isMongo() ? "mongo-history" : "sql-history");
  function defaultSchemaName() {
    const d = S.meta.driver;
    if (/postgres|cockroach/.test(d)) return "public";
    if (/mysql|mariadb|mongodb/.test(d)) return S.meta.database || "default";
    if (/mssql/.test(d)) return "dbo";
    return "main";
  }
  const schemaOf = (t) => t.schema || defaultSchemaName();

  /** Prisma Studio column order: primary key(s) first, then alphabetical. */
  function orderedColumns(t) {
    const pk = t.columns.filter((c) => c.isPrimary);
    const rest = t.columns.filter((c) => !c.isPrimary).sort((a, b) => a.name.localeCompare(b.name));
    return [...pk, ...rest];
  }
  /** Back-reference columns (the "many" side of a relation), shown with an arrow like Prisma Studio. */
  function relationColumns(t) {
    return t.relations
      .filter((r) => r.kind === "one-to-many" || r.kind === "many-to-many" || (r.kind === "one-to-one" && !r.joinColumns.length))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  /** Grid columns: data columns + relation columns, pinned ones first. */
  function gridColumns() {
    const t = T();
    const cols = [
      ...orderedColumns(t).map((c) => ({ key: c.name, col: c })),
      ...relationColumns(t).map((r) => ({ key: "→" + r.name, rel: r })),
    ];
    const pins = S.pinned[S.table] || [];
    const pinned = pins.map((k) => cols.find((c) => c.key === k)).filter(Boolean);
    return [...pinned.map((c) => ({ ...c, pinned: true })), ...cols.filter((c) => !pins.includes(c.key))];
  }
  function displayRows() {
    return [...S.newRows.map((data, ni) => ({ kind: "new", ni, data })), ...S.rows.map((data, ri) => ({ kind: "row", ri, data }))];
  }
  function cellValue(dr, key) {
    if (dr.kind === "new") return dr.data[key];
    const e = S.edits.get(dr.ri);
    return e && key in e ? e[key] : dr.data[key];
  }
  function cellEditable(dr, gc) {
    if (!gc.col || isReadOnly()) return false;
    if (dr.kind === "new") return true; // any column may be set explicitly on insert
    return !(gc.col.isGenerated && gc.col.isPrimary);
  }
  const hasDefault = (c) => c.defaultValue !== null || c.isGenerated || c.isManaged;
  const isRequired = (c) => !c.nullable && !hasDefault(c);

  /* ---------- value display ---------- */
  function asText(v, c) {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") return JSON.stringify(v, null, c && c.group === "json" ? 2 : 0);
    return String(v);
  }
  function highlight(text) {
    const q = S.search.trim();
    if (!q || !text) return text;
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return text;
    return [text.slice(0, i), el("mark", { text: text.slice(i, i + q.length) }), text.slice(i + q.length)];
  }
  function format(c, v) {
    if (v === null || v === undefined) return el("span", { class: "null", text: "NULL" });
    if (v && typeof v === "object" && "$binary" in v) return el("span", { class: "null", text: `<binary ${atob(v.$binary).length} bytes>` });
    if ((c && c.group === "boolean") || typeof v === "boolean") return String(v === true || v === 1 || v === "1" || v === "true" || v === "t");
    const text = typeof v === "object" ? JSON.stringify(v) : String(v);
    return el("span", {}, highlight(text));
  }
  function tsvEscape(s) { return /[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
  function parseTsv(text) {
    const rows = [];
    let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"' && cell === "") q = true;
      else if (ch === "\t") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  /* ================================================================ */
  /* sidebar                                                          */
  /* ================================================================ */
  function renderSchemas() {
    const schemas = [...new Set(S.meta.tables.map(schemaOf))].sort();
    if (!S.schema || !schemas.includes(S.schema)) S.schema = schemas.includes(defaultSchemaName()) ? defaultSchemaName() : schemas[0];
    const sel = $("#schema");
    sel.replaceChildren(...schemas.map((s) => el("option", { value: s, text: s, selected: s === S.schema })));
    sel.disabled = schemas.length < 2;
  }
  function renderSidebar() {
    document.querySelectorAll("#views a").forEach((a) => a.classList.toggle("active", a.dataset.view === S.view));
    const q = $("#tables-search").value.trim().toLowerCase();
    const list = S.meta.tables
      .filter((t) => schemaOf(t) === S.schema)
      .filter((t) => !q || t.tableName.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))
      .sort((a, b) => a.tableName.localeCompare(b.tableName));
    const nav = $("#tables");
    nav.replaceChildren(...(list.length ? list.map((t) => el("a", {
      href: "#", class: S.view === "table" && t.id === S.table ? "active" : "",
      title: `${t.id} (${t.kind}${t.readOnly ? ", read-only" : ""})`,
      onclick: (e) => { e.preventDefault(); openTable(t.id); },
    }, t.tableName)) : [el("div", { class: "none", text: "No matching tables" })]));
  }
  function toggleSidebar() {
    $("#app").classList.toggle("collapsed");
    store.set("collapsed", $("#app").classList.contains("collapsed"));
    if (S.view === "visualizer") requestAnimationFrame(drawLines);
    if (S.view === "table" && T()) requestAnimationFrame(renderGrid);
  }
  function wireSidebarResize() {
    const app = $("#app");
    const w = store.get("side-w", 0);
    if (w) app.style.setProperty("--side-w", w + "px");
    $("#sidebar-resizer").addEventListener("mousedown", (e) => {
      e.preventDefault();
      const move = (ev) => { const nw = Math.min(420, Math.max(160, ev.clientX)); app.style.setProperty("--side-w", nw + "px"); store.set("side-w", nw); };
      const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  }

  /* ================================================================ */
  /* views                                                            */
  /* ================================================================ */
  function setView(view) {
    if (view === S.view && view !== "table") return;
    if (S.view === "table" && view !== "table" && hasPending() && !confirm("You have unsaved edits. Leave them pending?")) return;
    S.view = view;
    writeHash(true);
    showView();
  }
  function showView() {
    for (const v of ["table", "visualizer", "console", "sql", "queries"]) $("#view-" + v).classList.toggle("hidden", v !== S.view);
    closeFloating();
    stopInsightsPolling();
    renderSidebar();
    if (S.view === "table") { if (T()) { renderFilterBar(); load(); } else renderEmptyTable(); }
    if (S.view === "visualizer") enterVisualizer();
    if (S.view === "console") renderConsole();
    if (S.view === "sql") enterSql();
    if (S.view === "queries") enterInsights();
  }
  function renderEmptyTable() {
    $("#grid").replaceChildren();
    $("#empty").classList.remove("hidden");
    $("#empty").textContent = S.meta.tables.length ? "Select a table" : "This DataSource has no entities.";
  }

  /* ================================================================ */
  /* TABLE VIEW                                                       */
  /* ================================================================ */
  function openTable(id, opts = {}) {
    if (S.view === "table" && !confirmDiscard()) return;
    S.view = "table";
    S.table = id;
    S.schema = schemaOf(T());
    S.page = 0;
    S.sort = [];
    S.search = opts.search || "";
    S.filter = opts.filter || emptyGroup();
    resetPending();
    pillsFromFilter();
    syncSearchUi();
    writeHash(true);
    for (const v of ["table", "visualizer", "console", "sql", "queries"]) $("#view-" + v).classList.toggle("hidden", v !== "table");
    stopInsightsPolling();
    closeFloating();
    renderSchemas();
    renderSidebar();
    renderFilterBar();
    $("#grid-wrap").scrollTo(0, 0);
    load();
  }
  function resetPending() {
    S.edits.clear();
    S.newRows = [];
    S.selected.clear();
    S.focus = null;
    S.anchor = null;
  }
  function syncSearchUi() {
    const open = !!S.search;
    $("#search-field").classList.toggle("hidden", !open);
    $("#search-btn").classList.toggle("hidden", open);
    $("#search").value = S.search;
  }

  async function load({ append = false } = {}) {
    const t = T();
    if (!t) return renderEmptyTable();
    const id = ++S.reqId;
    const page = append ? Math.floor(S.rows.length / S.size) : S.infinite ? 0 : S.page;
    $("#refresh-btn").disabled = true;
    try {
      const r = await call("query", {
        table: S.table, pageIndex: page, pageSize: S.size,
        sortOrder: S.sort, filter: S.filter, search: S.search || undefined,
      });
      if (id !== S.reqId) return;
      S.rows = append ? S.rows.concat(r.rows) : r.rows;
      S.total = r.filteredRowCount;
      if (!S.infinite && S.page > 0 && !r.rows.length && S.total > 0) {
        S.page = Math.max(0, Math.ceil(S.total / S.size) - 1);
        writeHash();
        return load();
      }
    } catch (e) {
      if (id !== S.reqId) return;
      if (!append) { S.rows = []; S.total = 0; }
      toast(e.message, true);
    } finally {
      if (id === S.reqId) { $("#refresh-btn").disabled = false; S.loadingMore = false; }
    }
    if (S.focus && S.focus.r >= displayRows().length) S.focus = null;
    render();
  }

  function render() {
    renderToolbar();
    renderGrid();
    renderPager();
  }
  function renderToolbar() {
    const ro = isReadOnly();
    $("#insert-btn").classList.toggle("hidden", ro);
    const n = pendingRows();
    $("#save-btn").classList.toggle("hidden", !n);
    $("#discard-btn").classList.toggle("hidden", !n);
    $("#save-btn").textContent = `Save ${plural(n, "row")}`;
    const s = S.selected.size;
    $("#copy-wrap").classList.toggle("hidden", !s);
    $("#delete-btn").classList.toggle("hidden", !s || ro);
    $("#delete-btn").textContent = `Delete ${plural(s, "row")}`;
    $("#filter-btn").classList.toggle("active", S.filter.filters.length > 0 || S.pills.length > 0);
    $("#table-note").textContent = T().readOnly ? (T().kind === "view" ? "read-only view" : "read-only (no primary key)") : S.meta.readOnly ? "read-only" : "";
  }
  function renderPager() {
    const pages = Math.max(1, Math.ceil(S.total / S.size));
    $("#pg-input").value = String(S.infinite ? 1 : S.page + 1);
    $("#pg-total").textContent = S.infinite ? "1" : pages.toLocaleString();
    const inf = S.infinite;
    $("#pg-first").disabled = inf || S.page <= 0;
    $("#pg-prev").disabled = inf || S.page <= 0;
    $("#pg-next").disabled = inf || S.page >= pages - 1;
    $("#pg-last").disabled = inf || S.page >= pages - 1;
    $("#pg-input").disabled = inf;
    $("#pg-size").value = String(S.size);
    $("#infinite").checked = inf;
    const shown = S.rows.length;
    $("#row-count").textContent = S.total ? (inf ? `${shown.toLocaleString()} of ${S.total.toLocaleString()} rows` : `${(S.page * S.size + 1).toLocaleString()}–${(S.page * S.size + shown).toLocaleString()} of ${S.total.toLocaleString()} rows`) : "";
  }

  function colWidth(gc) {
    const w = (S.widths[S.table] || {})[gc.key];
    if (w) return w;
    if (gc.rel) return 160;
    const c = gc.col;
    if (c.group === "boolean") return 150;
    if (c.group === "numeric") return 170;
    if (c.group === "datetime") return 220;
    return 200;
  }

  /* ---------- grid ---------- */
  function renderGrid() {
    const t = T();
    const cols = gridColumns();
    const ro = isReadOnly();
    const drs = displayRows();
    const widths = [36, ...cols.map(colWidth)];
    // like Prisma Studio, columns stretch to fill the view when there is room (user-resized widths stay fixed)
    const avail = $("#grid-wrap").clientWidth;
    const total = widths.reduce((a, b) => a + b, 0);
    const userSized = S.widths[S.table] || {};
    const flex = cols.map((gc, i) => (userSized[gc.key] ? 0 : widths[i + 1]));
    const flexSum = flex.reduce((a, b) => a + b, 0);
    if (avail > total && flexSum > 0) {
      let extra = avail - total - 1;
      cols.forEach((_, i) => { if (flex[i]) { const add = Math.floor(((avail - total - 1) * flex[i]) / flexSum); widths[i + 1] += add; extra -= add; } });
    }
    const lefts = [0];
    for (let i = 0; i < cols.length; i++) lefts.push(lefts[i] + widths[i]);
    const lastPin = cols.reduce((n, c, i) => (c.pinned ? i : n), -1);
    const grid = $("#grid");
    grid.style.width = widths.reduce((a, b) => a + b, 0) + "px";
    const pinStyle = (i) => (cols[i].pinned ? { left: lefts[i + 1] + "px" } : null);
    const pinClass = (i) => (cols[i].pinned ? "pinned" + (i === lastPin ? " lastpin" : "") : "");

    const allSel = S.rows.length > 0 && S.selected.size === S.rows.length;
    const head = el("tr", {},
      el("th", { class: "rowsel", title: ro ? "" : allSel ? "Deselect all" : "Select all rows", onclick: () => !ro && toggleAll(!allSel) }, allSel ? "✓" : ""),
      cols.map((gc, i) => {
        if (gc.rel) {
          return el("th", { class: pinClass(i), style: pinStyle(i), title: `${gc.rel.kind} → ${gc.rel.target}` },
            el("div", { class: "h" }, el("span", { class: "name", text: gc.rel.name })),
            resizeHandle(gc.key));
        }
        const c = gc.col;
        const si = S.sort.findIndex((s) => s.column === c.name);
        const sorted = si >= 0 ? S.sort[si].direction : null;
        const pinned = !!gc.pinned;
        return el("th", { class: pinClass(i), style: pinStyle(i), title: `${c.propertyPath}: ${c.type}${c.dbType && c.dbType !== c.type ? ` (${c.dbType})` : ""}${c.nullable ? " (nullable)" : ""}${c.defaultValue ? ` · default ${c.defaultValue}` : ""}${c.fk ? ` · → ${c.fk.entity}.${c.fk.column}` : ""}` },
          el("div", { class: "h" },
            c.isPrimary ? ico("key", "pk") : c.fk ? ico("key", "fk") : isRequired(c) ? el("span", { class: "req", text: "*", title: "required" }) : null,
            sorted ? ico(sorted === "asc" ? "up" : "down", "sorted") : null,
            el("span", { class: "name", text: c.name }),
            el("span", { class: "type", text: (c.dbType || c.type) + (c.isArray ? "[]" : "") }),
            el("span", { class: "hctl" + (pinned || sorted ? " on" : "") },
              el("button", { class: pinned ? "on" : "", title: pinned ? "Unpin column" : "Pin column", "aria-label": pinned ? "Unpin column" : "Pin column", onclick: (e) => { e.stopPropagation(); togglePin(gc.key); } }, ico("pin")),
              el("button", { class: sorted ? "on" : "", title: "Sort (Shift: add to sort)", "aria-label": sorted === "asc" ? "Sort descending" : sorted === "desc" ? "Clear sort" : "Sort ascending", onclick: (e) => { e.stopPropagation(); toggleSort(c.name, e.shiftKey); } }, ico(sorted === "asc" ? "down" : "up"))),
          ),
          resizeHandle(gc.key));
      }),
    );

    const range = selectionRange();
    const body = el("tbody");
    drs.forEach((dr, r) => {
      const selected = dr.kind === "row" && S.selected.has(dr.ri);
      const rs = el("td", {
        class: "rowsel",
        title: dr.kind === "new" ? "Remove this new row" : selected ? "Deselect row" : "Select row (Shift: range)",
        onclick: (e) => dr.kind === "new" ? removeDraft(dr.ni) : !ro && toggleRow(dr.ri, e.shiftKey),
      }, dr.kind === "new" ? "−" : selected ? "✓" : "");
      body.append(el("tr", { class: dr.kind === "new" ? "new" : selected ? "selected" : "" }, rs, cols.map((gc, ci) => dataCell(dr, r, gc, ci, range, pinClass(ci), pinStyle(ci)))));
    });
    grid.replaceChildren(el("colgroup", {}, widths.map((w) => el("col", { style: { width: w + "px" } }))), el("thead", {}, head), body);
    $("#empty").classList.toggle("hidden", drs.length > 0);
    $("#empty").textContent = S.filter.filters.length || S.search ? "No rows match the current filters." : "No rows";
  }

  function dataCell(dr, r, gc, ci, range, pinCls, pinSt) {
    const focused = S.focus && S.focus.r === r && S.focus.c === ci;
    const inRange = range && !focused && r >= range.r1 && r <= range.r2 && ci >= range.c1 && ci <= range.c2;
    const base = { "data-r": r, "data-c": ci, style: pinSt };
    const onDown = (e) => {
      if (e.target.closest("button")) return;
      if (e.shiftKey && S.focus) { S.anchor ||= { ...S.focus }; S.focus = { r, c: ci }; }
      else { S.focus = { r, c: ci }; S.anchor = null; }
      paintFocus();
      $("#grid-wrap").focus({ preventScroll: true });
    };
    if (gc.rel) {
      return el("td", { ...base, class: [pinCls, focused && "focus", inRange && "in-range"].filter(Boolean).join(" "), onmousedown: onDown },
        dr.kind === "new" ? "" : el("div", { class: "cellwrap" }, el("span", {}), el("button", { class: "go", title: `Show related ${gc.rel.target} rows`, "aria-label": `Show related ${gc.rel.target} rows`, onclick: () => followRelation(gc.rel, dr.data) }, ico("arrow"))));
    }
    const c = gc.col;
    const v = cellValue(dr, c.name);
    const editable = cellEditable(dr, gc);
    const edited = dr.kind === "row" && c.name in (S.edits.get(dr.ri) || {});
    const set = dr.kind === "new" && c.name in dr.data;
    const td = el("td", {
      ...base,
      class: [pinCls, edited && "edited", set && "set", !editable && "readonly", focused && "focus", inRange && "in-range"].filter(Boolean).join(" "),
      title: asText(v, c).slice(0, 400),
      onmousedown: onDown,
      ondblclick: () => editable && beginEdit(r, ci),
    });
    let content;
    if (dr.kind === "new" && !set) content = c.isGenerated || c.isManaged || c.defaultValue !== null ? "(default value)" : c.nullable ? "NULL" : c.group === "string" ? "(empty string)" : "(required)";
    else content = format(c, v);
    if (c.fk && v !== null && v !== undefined && dr.kind === "row") {
      td.append(el("div", { class: "cellwrap" }, el("span", {}, content), el("button", { class: "go", title: `Open ${c.fk.entity} where ${c.fk.column} = ${v}`, "aria-label": `Open referenced ${c.fk.entity}`, onclick: () => followFk(c, v) }, ico("arrow"))));
    } else td.append(content);
    return td;
  }

  function paintFocus() {
    const range = selectionRange();
    document.querySelectorAll("#grid td[data-r]").forEach((td) => {
      const r = +td.dataset.r, c = +td.dataset.c;
      const f = S.focus && S.focus.r === r && S.focus.c === c;
      td.classList.toggle("focus", !!f);
      td.classList.toggle("in-range", !!(range && !f && r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2));
      if (f) td.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }
  function selectionRange() {
    if (!S.focus || !S.anchor) return null;
    return { r1: Math.min(S.focus.r, S.anchor.r), r2: Math.max(S.focus.r, S.anchor.r), c1: Math.min(S.focus.c, S.anchor.c), c2: Math.max(S.focus.c, S.anchor.c) };
  }

  function resizeHandle(key) {
    return el("span", {
      class: "resize",
      onclick: (e) => e.stopPropagation(),
      ondblclick: (e) => { e.stopPropagation(); const w = S.widths[S.table] || {}; delete w[key]; S.widths[S.table] = w; store.set("widths", S.widths); renderGrid(); },
      onmousedown: (e) => {
        e.preventDefault();
        e.stopPropagation();
        const th = e.target.parentElement;
        const startX = e.clientX;
        const startW = th.getBoundingClientRect().width;
        const handle = e.target;
        handle.classList.add("dragging");
        const idx = [...th.parentElement.children].indexOf(th);
        const colEl = $("#grid colgroup").children[idx];
        const move = (ev) => {
          const w = Math.max(70, Math.round(startW + ev.clientX - startX));
          colEl.style.width = w + "px";
          $("#grid").style.width = [...$("#grid colgroup").children].reduce((a, c) => a + parseFloat(c.style.width), 0) + "px";
          (S.widths[S.table] ||= {})[key] = w;
        };
        const up = () => {
          handle.classList.remove("dragging");
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          store.set("widths", S.widths);
          if ((S.pinned[S.table] || []).length) renderGrid();
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      },
    });
  }
  function togglePin(key) {
    const pins = S.pinned[S.table] || [];
    S.pinned[S.table] = pins.includes(key) ? pins.filter((k) => k !== key) : [...pins, key];
    store.set("pinned", S.pinned);
    S.focus = null;
    S.anchor = null;
    renderGrid();
  }

  /* ---------- selection ---------- */
  let lastToggled = null;
  function toggleRow(ri, shift) {
    if (shift && lastToggled !== null) {
      const [a, b] = [Math.min(lastToggled, ri), Math.max(lastToggled, ri)];
      for (let i = a; i <= b; i++) S.selected.add(i);
    } else if (S.selected.has(ri)) S.selected.delete(ri);
    else S.selected.add(ri);
    lastToggled = ri;
    renderToolbar();
    renderGrid();
  }
  function toggleAll(on) {
    S.selected = new Set(on ? S.rows.map((_, i) => i) : []);
    renderToolbar();
    renderGrid();
  }

  /* ---------- popover editors ---------- */
  function closeFloating() {
    floatingAnchor = null;
    $("#popover").classList.add("hidden");
    $("#popover").replaceChildren();
    $("#menu").classList.add("hidden");
    $("#menu").replaceChildren();
    document.removeEventListener("mousedown", outsideClose, true);
  }
  function outsideClose(e) {
    if (e.target.closest("#popover, #menu")) return;
    if (floatingOnClose) floatingOnClose();
    closeFloating();
  }
  let floatingOnClose = null;
  let floatingAnchor = null;
  function place(node, anchor, { width } = {}) {
    node.classList.remove("hidden");
    if (width) node.style.width = width + "px";
    floatingAnchor = { node, anchor };
    position(node, anchor);
    setTimeout(() => document.addEventListener("mousedown", outsideClose, true), 0);
  }
  function position(node, anchor) {
    const a = anchor.getBoundingClientRect();
    const w = node.offsetWidth, h = node.offsetHeight;
    let left = Math.min(a.left, window.innerWidth - w - 8);
    let top = a.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 4);
    node.style.left = Math.max(8, left) + "px";
    node.style.top = top + "px";
  }
  /** Keep an open editor attached to its cell while the grid scrolls; close it once the cell leaves the view. */
  function followAnchor() {
    if (!floatingAnchor || floatingAnchor.node.classList.contains("hidden")) return;
    const { node, anchor } = floatingAnchor;
    const a = anchor.getBoundingClientRect();
    const v = $("#grid-wrap").getBoundingClientRect();
    if (!anchor.isConnected || a.bottom < v.top + 40 || a.top > v.bottom || a.right < v.left || a.left > v.right) {
      if (floatingOnClose) floatingOnClose();
      closeFloating();
    } else position(node, anchor);
  }

  function setCell(dr, key, value) {
    if (dr.kind === "new") { dr.data[key] = value; return; }
    const orig = S.rows[dr.ri][key];
    const e = S.edits.get(dr.ri) || {};
    const same = orig === null || orig === undefined ? value === null || value === undefined : value !== null && value !== undefined && asText(orig) === asText(value);
    if (same) delete e[key]; else e[key] = value;
    if (Object.keys(e).length) S.edits.set(dr.ri, e); else S.edits.delete(dr.ri);
  }
  function tzLabel() {
    const off = -new Date().getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const a = Math.abs(off);
    return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
  }
  function toLocalInput(v, withTime) {
    if (v === null || v === undefined || v === "") return "";
    const d = new Date(typeof v === "string" && v.length === 10 ? v + "T00:00:00" : v);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    return withTime ? `${date}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : date;
  }

  /** Cell editor in a popover under the cell (Prisma Studio style). Enter saves, Esc cancels. */
  function beginEdit(r, ci, initialText) {
    const dr = displayRows()[r];
    const gc = gridColumns()[ci];
    if (!dr || !gc || !cellEditable(dr, gc)) return;
    const c = gc.col;
    const td = document.querySelector(`#grid td[data-r="${r}"][data-c="${ci}"]`);
    if (!td) return;
    S.focus = { r, c: ci };
    S.anchor = null;
    paintFocus();
    const current = cellValue(dr, c.name);
    const pop = $("#popover");
    closeFloating();
    let done = false;
    const commit = (v) => { if (done) return; done = true; closeFloating(); setCell(dr, c.name, v); render(); $("#grid-wrap").focus({ preventScroll: true }); };
    const cancel = () => { if (done) return; done = true; closeFloating(); $("#grid-wrap").focus({ preventScroll: true }); };
    floatingOnClose = null;
    const foot = (...extra) => el("div", { class: "pv-foot" },
      ...extra,
      el("button", { type: "button", onclick: cancel }, el("kbd", {}, "Esc"), "Cancel changes"),
      c.nullable ? el("button", { type: "button", onclick: () => commit(null) }, "Set NULL") : null,
      dr.kind === "new" && hasDefault(c) ? el("button", { type: "button", onclick: () => { done = true; closeFloating(); delete dr.data[c.name]; render(); } }, "Use default") : null);

    if (c.group === "boolean" || c.group === "enum") {
      const opts = c.group === "boolean" ? [true, false] : c.enumValues;
      const cur = current === 1 ? true : current === 0 ? false : current;
      const buttons = opts.map((o) => el("button", { type: "button", class: o === cur ? "cur" : "", onclick: () => commit(o) }, String(o)));
      if (c.nullable) buttons.push(el("button", { type: "button", class: cur === null ? "cur" : "", onclick: () => commit(null) }, "NULL"));
      let idx = Math.max(0, buttons.findIndex((b) => b.classList.contains("cur")));
      const list = el("div", { class: "opt-list", role: "listbox", tabindex: "0", onkeydown: (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); buttons[idx].classList.remove("cur"); idx = (idx + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length; buttons[idx].classList.add("cur"); }
        else if (e.key === "Enter") { e.preventDefault(); buttons[idx].click(); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
      } }, buttons);
      pop.replaceChildren(el("div", { class: "pv-body" }, list), foot());
      place(pop, td, { width: Math.max(220, td.offsetWidth) });
      list.focus();
      return;
    }
    let input;
    let read;
    if (c.group === "datetime") {
      const dateOnly = c.type === "date";
      input = el("input", { type: dateOnly ? "date" : "datetime-local", step: "0.001", value: toLocalInput(current, !dateOnly), "aria-label": c.name });
      read = () => (input.value ? (dateOnly ? input.value : new Date(input.value).toISOString()) : c.nullable ? null : "");
      pop.replaceChildren(el("div", { class: "pv-body" }, el("div", { class: "mono small", text: asText(current) || "NULL" }), input,
        el("div", { class: "note", text: dateOnly ? "" : `Editing in local time (${tzLabel()})` })),
        foot(el("button", { type: "button", onclick: () => commit(dateOnly ? toLocalInput(new Date(), false) : new Date().toISOString()) }, "Now"), el("button", { type: "button", onclick: () => commit(read()) }, el("kbd", {}, "↵"), "Save")));
    } else {
      input = el("textarea", { rows: c.group === "json" ? 8 : 1, spellcheck: "false", "aria-label": c.name });
      input.value = initialText ?? (c.group === "json" && typeof current === "string" ? prettyJson(current) : asText(current, c));
      read = () => input.value;
      const auto = () => { if (c.group !== "json") { input.style.height = "auto"; input.style.height = Math.min(300, input.scrollHeight + 2) + "px"; } };
      input.addEventListener("input", auto);
      pop.replaceChildren(el("div", { class: "pv-body" }, input), foot(el("button", { type: "button", onclick: () => trySave() }, el("kbd", {}, "↵"), "Save"), c.group === "json" ? null : el("span", {}, el("kbd", {}, "⇧↵"), " newline")));
      setTimeout(auto, 0);
    }
    const trySave = () => {
      const v = read();
      if (c.group === "json" && v !== null && v !== "") { try { JSON.parse(v); } catch (e) { toast("Invalid JSON: " + e.message, true); return; } }
      if (c.group === "numeric" && v !== null && v !== "" && Number.isNaN(Number(v))) { toast(`"${v}" is not a number`, true); return; }
      commit(v);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
      else if (e.key === "Enter" && (c.group !== "json" ? !e.shiftKey : e.ctrlKey || e.metaKey)) { e.preventDefault(); trySave(); }
      else if (e.key === "Tab") { e.preventDefault(); trySave(); moveFocus(0, e.shiftKey ? -1 : 1); }
    });
    floatingOnClose = () => { if (!done) trySave(); };
    place(pop, td, { width: Math.max(280, Math.min(460, td.offsetWidth + 80)) });
    input.focus();
    if (initialText !== undefined && input.setSelectionRange) input.setSelectionRange(input.value.length, input.value.length);
    else if (input.select) input.select();
  }
  function prettyJson(s) { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } }

  /* ---------- keyboard navigation, copy & paste ---------- */
  function moveFocus(dr, dc, extend = false) {
    const rows = displayRows().length;
    const cols = gridColumns().length;
    if (!rows || !cols) return;
    if (!S.focus) { S.focus = { r: 0, c: 0 }; paintFocus(); return; }
    if (extend) S.anchor ||= { ...S.focus }; else S.anchor = null;
    S.focus = { r: Math.min(rows - 1, Math.max(0, S.focus.r + dr)), c: Math.min(cols - 1, Math.max(0, S.focus.c + dc)) };
    paintFocus();
  }
  function onGridKey(e) {
    if (S.view !== "table" || !T()) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") { if (hasPending()) { e.preventDefault(); save(); } return; }
    if (document.activeElement !== $("#grid-wrap")) return;
    const k = e.key;
    const nav = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (nav[k]) { e.preventDefault(); moveFocus(mod ? nav[k][0] * 99999 : nav[k][0], mod ? nav[k][1] * 99999 : nav[k][1], e.shiftKey); return; }
    if (k === "Tab") { e.preventDefault(); moveFocus(0, e.shiftKey ? -1 : 1); return; }
    if (k === "Home") { e.preventDefault(); moveFocus(mod ? -99999 : 0, -99999, e.shiftKey); return; }
    if (k === "End") { e.preventDefault(); moveFocus(mod ? 99999 : 0, 99999, e.shiftKey); return; }
    if (k === "PageDown") { e.preventDefault(); moveFocus(15, 0); return; }
    if (k === "PageUp") { e.preventDefault(); moveFocus(-15, 0); return; }
    if (k === "Escape") { S.focus = null; S.anchor = null; paintFocus(); return; }
    if (!S.focus) return;
    const dr = displayRows()[S.focus.r];
    const gc = gridColumns()[S.focus.c];
    if (k === "Enter" || k === "F2") { e.preventDefault(); beginEdit(S.focus.r, S.focus.c); return; }
    if (k === " " && !mod && gc && gc.col && gc.col.group === "boolean" && cellEditable(dr, gc)) {
      e.preventDefault();
      const cur = cellValue(dr, gc.col.name);
      setCell(dr, gc.col.name, !(cur === true || cur === 1));
      render();
      return;
    }
    if (k === "Delete" || k === "Backspace") {
      e.preventDefault();
      forEachCellInSelection((d, g) => { if (cellEditable(d, g)) setCell(d, g.col.name, g.col.nullable ? null : ""); });
      render();
      return;
    }
    if (k.length === 1 && !mod && !e.altKey && gc && gc.col && !["boolean", "enum", "datetime", "json"].includes(gc.col.group)) {
      e.preventDefault();
      beginEdit(S.focus.r, S.focus.c, k);
    }
  }
  function forEachCellInSelection(fn) {
    const rows = displayRows();
    const cols = gridColumns();
    const range = selectionRange() || (S.focus && { r1: S.focus.r, r2: S.focus.r, c1: S.focus.c, c2: S.focus.c });
    if (!range) return;
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) if (rows[r] && cols[c] && cols[c].col) fn(rows[r], cols[c], r, c);
  }
  function rangeAsTsv() {
    const range = selectionRange() || (S.focus && { r1: S.focus.r, r2: S.focus.r, c1: S.focus.c, c2: S.focus.c });
    if (!range) return null;
    const rows = displayRows();
    const cols = gridColumns();
    const lines = [];
    for (let r = range.r1; r <= range.r2; r++) {
      const vals = [];
      for (let c = range.c1; c <= range.c2; c++) vals.push(cols[c].col ? tsvEscape(asText(cellValue(rows[r], cols[c].col.name))) : "");
      lines.push(vals.join("\t"));
    }
    return lines.join("\n");
  }
  function onCopy(e) {
    if (S.view !== "table" || document.activeElement !== $("#grid-wrap")) return;
    const text = rangeAsTsv();
    if (text === null) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", text);
    toast("Copied");
  }
  function onPaste(e) {
    if (S.view !== "table" || document.activeElement !== $("#grid-wrap") || !S.focus || isReadOnly()) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const grid = parseTsv(text.replace(/\r?\n$/, ""));
    const rows = displayRows();
    const cols = gridColumns();
    let n = 0;
    const apply = (dr, gc, raw) => {
      if (!dr || !gc || !gc.col || !cellEditable(dr, gc)) return;
      setCell(dr, gc.col.name, raw === "NULL" && gc.col.nullable ? null : raw);
      n++;
    };
    if (grid.length === 1 && grid[0].length === 1 && selectionRange()) forEachCellInSelection((dr, gc) => apply(dr, gc, grid[0][0]));
    else grid.forEach((line, dy) => line.forEach((raw, dx) => apply(rows[S.focus.r + dy], cols[S.focus.c + dx], raw)));
    render();
    if (n) toast(`Pasted into ${plural(n, "cell")} — review and save`);
  }

  /* ---------- copy as ---------- */
  function selectedRowObjects() {
    const cols = orderedColumns(T());
    return [...S.selected].sort((a, b) => a - b).map((ri) => Object.fromEntries(cols.map((c) => [c.name, cellValue({ kind: "row", ri, data: S.rows[ri] }, c.name) ?? null])));
  }
  function copyAs(format) {
    const objs = selectedRowObjects();
    const cols = orderedColumns(T()).map((c) => c.name);
    let text;
    const cell = (v) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
    if (format === "json") text = JSON.stringify(objs, null, 2);
    else if (format === "csv") text = [cols.join(","), ...objs.map((o) => cols.map((c) => { const s = cell(o[c]); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(","))].join("\n");
    else if (format === "tsv") text = [cols.join("\t"), ...objs.map((o) => cols.map((c) => tsvEscape(cell(o[c]))).join("\t"))].join("\n");
    else text = [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`, ...objs.map((o) => `| ${cols.map((c) => cell(o[c]).replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`)].join("\n");
    closeFloating();
    navigator.clipboard.writeText(text).then(() => toast(`Copied ${plural(objs.length, "row")} as ${format.toUpperCase()}`), () => toast("Clipboard is not available here", true));
  }
  function openCopyMenu() {
    const m = $("#menu");
    m.replaceChildren(el("div", { class: "m-items" },
      [["csv", "CSV"], ["json", "JSON"], ["markdown", "Markdown"], ["tsv", "TSV (spreadsheet)"]].map(([f, label]) => el("button", { class: "m-item", role: "menuitem", onclick: () => copyAs(f) }, ico("copy"), label))));
    place(m, $("#copy-btn"), { width: 220 });
  }

  /* ---------- save / insert / delete ---------- */
  function insertRow() {
    if (isReadOnly()) return;
    S.newRows.unshift({});
    S.focus = { r: 0, c: 0 };
    S.anchor = null;
    render();
    $("#grid-wrap").scrollTo({ top: 0 });
    $("#grid-wrap").focus({ preventScroll: true });
  }
  function removeDraft(ni) {
    S.newRows.splice(ni, 1);
    S.focus = null;
    render();
  }
  async function save() {
    const t = T();
    const btn = $("#save-btn");
    btn.disabled = true;
    try {
      if (S.newRows.length) {
        // like Prisma Studio: untouched required text columns are inserted as empty strings
        const rows = S.newRows.map((row) => {
          const out = { ...row };
          for (const c of t.columns) if (!(c.name in out) && isRequired(c) && c.group === "string" && !c.fk) out[c.name] = "";
          return out;
        });
        await call("insert", { table: t.id, rows });
      }
      if (S.edits.size) {
        const updates = [...S.edits.entries()].map(([ri, changes]) => ({ row: pkOf(S.rows[ri]), changes }));
        await call("update", { table: t.id, updates });
      }
      const n = pendingRows();
      resetPending();
      toast(`Saved ${plural(n, "row")}`);
      await load();
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  }
  const pkOf = (row) => Object.fromEntries(T().primaryKeys.map((k) => [k, row[k]]));
  async function deleteSelected() {
    const n = S.selected.size;
    if (!n || !confirm(`Delete ${plural(n, "row")} from ${T().tableName}? This cannot be undone.`)) return;
    try {
      const r = await call("delete", { table: S.table, rows: [...S.selected].map((ri) => pkOf(S.rows[ri])) });
      toast(`Deleted ${plural(r.affected, "row")}`);
      resetPending();
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  }

  /* ---------- sort / relations ---------- */
  function toggleSort(col, additive) {
    if (!confirmDiscard()) return;
    const i = S.sort.findIndex((s) => s.column === col);
    const next = i < 0 ? { column: col, direction: "asc" } : S.sort[i].direction === "asc" ? { column: col, direction: "desc" } : null;
    if (additive) {
      S.sort = S.sort.filter((s) => s.column !== col);
      if (next) S.sort.splice(i < 0 ? S.sort.length : i, 0, next);
    } else S.sort = next ? [next] : [];
    S.page = 0;
    resetPending();
    writeHash();
    load();
  }
  const eqFilter = (pairs) => ({ kind: "FilterGroup", id: "root", after: "and", filters: pairs.map(([column, value]) => ({ kind: "ColumnFilter", id: uid(), column, operator: "=", value, after: "and" })) });
  const followFk = (c, value) => openTable(c.fk.entity, { filter: eqFilter([[c.fk.column, value]]) });
  function followRelation(r, row) {
    if (r.junction) openTable(r.junction.entity, { filter: eqFilter(r.junction.ownerColumns.map((p) => [p.column, row[p.referencedColumn]])) });
    else openTable(r.target, { filter: eqFilter(r.inverseJoinColumns.map((p) => [p.column, row[p.referencedColumn]])) });
  }

  /* ---------- filters: column menu + pills ---------- */
  const OPS = [
    { group: "Comparison", items: [["=", "Equal", "="], ["!=", "Not equal", "!="], [">", "Greater than", ">"], [">=", "Greater than or equal", ">="], ["<", "Less than", "<"], ["<=", "Less than or equal", "<="]] },
    { group: "Text", items: [["contains", "Contains", "ILIKE"], ["not contains", "Does not contain", "NOT ILIKE"], ["starts with", "Starts with", "x%"], ["ends with", "Ends with", "%x"], ["like", "Matches pattern", "LIKE"]] },
    { group: "List", items: [["in", "Is one of", "IN"]] },
    { group: "Null checks", items: [["is null", "Is null", "IS"], ["is not null", "Is not null", "IS NOT"]] },
  ];
  const opLabel = (op) => { for (const g of OPS) for (const [v, l] of g.items) if (v === op) return l; return op; };
  const NO_VALUE = new Set(["is null", "is not null"]);

  /** Searchable menu (used for columns and operators). items: [{label, hint, icon, group, onSelect}] */
  function openSearchMenu(anchor, placeholder, items, { width = 320 } = {}) {
    const m = $("#menu");
    const input = el("input", { type: "text", placeholder, "aria-label": placeholder });
    const list = el("div", { class: "m-items", role: "listbox" });
    let cur = 0;
    let visible = [];
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      visible = items.filter((it) => !q || it.label.toLowerCase().includes(q) || (it.hint || "").toLowerCase().includes(q));
      cur = Math.min(cur, Math.max(0, visible.length - 1));
      const nodes = [];
      let lastGroup = null;
      visible.forEach((it, i) => {
        if (it.group && it.group !== lastGroup) { nodes.push(el("div", { class: "m-group", text: it.group })); lastGroup = it.group; }
        if (it.sepBefore && i > 0) nodes.push(el("div", { class: "m-sep" }));
        nodes.push(el("button", { class: "m-item" + (i === cur ? " cur" : ""), role: "option", onmouseenter: () => { cur = i; mark(); }, onclick: () => { closeFloating(); it.onSelect(); } },
          it.icon ? ico(it.icon) : null, el("span", { text: it.label }), it.hint ? el("span", { class: "hint", text: it.hint }) : null));
      });
      list.replaceChildren(...(nodes.length ? nodes : [el("div", { class: "m-group", text: "No matches" })]));
    };
    const mark = () => list.querySelectorAll(".m-item").forEach((b, i) => b.classList.toggle("cur", i === cur));
    input.addEventListener("input", () => { cur = 0; draw(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); cur = Math.min(visible.length - 1, cur + 1); mark(); list.querySelectorAll(".m-item")[cur]?.scrollIntoView({ block: "nearest" }); }
      else if (e.key === "ArrowUp") { e.preventDefault(); cur = Math.max(0, cur - 1); mark(); list.querySelectorAll(".m-item")[cur]?.scrollIntoView({ block: "nearest" }); }
      else if (e.key === "Enter") { e.preventDefault(); const it = visible[cur]; if (it) { closeFloating(); it.onSelect(); } }
      else if (e.key === "Escape") { e.preventDefault(); closeFloating(); }
    });
    m.replaceChildren(el("div", { class: "m-search" }, ico("search"), input), list);
    draw();
    floatingOnClose = null;
    place(m, anchor, { width });
    input.focus();
  }

  function openFilterMenu() {
    const t = T();
    if (!t) return;
    const items = [];
    if (!S.meta.readOnly) {
      items.push(isMongo()
        ? { label: "Mongo query document", hint: "Raw JSON", icon: "code", onSelect: () => addPill({ kind: "SqlFilter", id: uid(), sql: "", after: "and" }) }
        : { label: "SQL WHERE clause", hint: "Raw SQL", icon: "code", onSelect: () => addPill({ kind: "SqlFilter", id: uid(), sql: "", after: "and" }) });
    }
    orderedColumns(t).forEach((c, i) => items.push({ label: c.name, hint: c.dbType || c.type, icon: "db", sepBefore: i === 0 && items.length > 0, onSelect: () => addPill({ kind: "ColumnFilter", id: uid(), column: c.name, operator: null, value: "", after: "and" }) }));
    openSearchMenu($("#filter-btn"), "Select column to filter…", items);
  }
  function addPill(p) {
    S.pills.push(p);
    renderFilterBar();
    if (p.kind === "ColumnFilter") openOperatorMenu(p);
    else focusPill(p);
  }
  /** Focus a pill's value box synchronously so fast typing is never lost. */
  function focusPill(p) {
    const input = document.querySelector(`.pill[data-id="${p.id}"] input`);
    if (input) { input.focus(); input.setSelectionRange?.(input.value.length, input.value.length); }
  }
  function openOperatorMenu(p) {
    const anchor = document.querySelector(`.pill[data-id="${p.id}"] .op`);
    if (!anchor) return;
    const items = [];
    for (const g of OPS) for (const [v, label, hint] of g.items) items.push({ label, hint, group: g.group, onSelect: () => { p.operator = v; p.dirty = true; renderFilterBar(); if (NO_VALUE.has(v)) applyPills(); else focusPill(p); } });
    openSearchMenu(anchor, "Select operator…", items);
  }
  /** Pills mirror the applied filter (flattened) plus drafts. */
  function pillsFromFilter() {
    const flat = [];
    const walk = (g) => g.filters.forEach((f) => (f.kind === "FilterGroup" ? walk(f) : flat.push({ ...f })));
    walk(S.filter);
    S.pills = flat;
  }
  function renderFilterBar() {
    const bar = $("#filter-bar");
    if (!S.pills.length) { bar.classList.add("hidden"); bar.replaceChildren(); renderToolbarFilterState(); return; }
    bar.classList.remove("hidden");
    const nodes = [];
    S.pills.forEach((p, i) => {
      if (i > 0) {
        const prev = S.pills[i - 1];
        nodes.push(el("button", { class: "pill", title: "Click to switch AND / OR", onclick: () => { prev.after = prev.after === "or" ? "and" : "or"; applyPills(); } }, el("span", { class: "join", text: prev.after || "and" })));
      }
      const remove = el("button", { class: "remove", title: "Remove filter", "aria-label": "Remove filter", onclick: () => { S.pills.splice(i, 1); applyPills(); } }, ico("x"));
      const apply = el("button", { class: "apply", title: "Apply filter (Enter)", "aria-label": "Apply filter", onclick: () => applyPills() }, ico("check"));
      if (p.kind === "SqlFilter") {
        nodes.push(el("div", { class: "pill" + (p.dirty ? " dirty" : ""), "data-id": p.id },
          el("span", { class: "col" }, ico("code"), isMongo() ? "QUERY" : "WHERE"),
          el("input", { class: "val sqlv", type: "text", value: p.sql, placeholder: isMongo() ? "{ views: { $gt: 100 } }" : `"views" > 100`, "aria-label": isMongo() ? "Mongo query document" : "SQL WHERE clause", spellcheck: "false",
            oninput: (e) => { p.sql = e.target.value; p.dirty = true; e.target.closest(".pill").classList.add("dirty"); },
            onkeydown: (e) => { if (e.key === "Enter") applyPills(); } }),
          apply, remove));
      } else {
        const c = T().columns.find((x) => x.name === p.column);
        nodes.push(el("div", { class: "pill" + (p.dirty ? " dirty" : ""), "data-id": p.id },
          el("span", { class: "col" }, ico("db"), p.column),
          el("button", { class: "op" + (p.operator ? "" : " unset"), onclick: () => openOperatorMenu(p) }, p.operator ? opLabel(p.operator) : "Select operator…"),
          p.operator && NO_VALUE.has(p.operator) ? null : el("input", {
            class: "val", type: c && c.group === "datetime" ? "text" : "text", value: p.value ?? "",
            placeholder: p.operator === "in" ? "a, b, c" : c && c.group === "datetime" ? "2026-01-31T00:00:00Z" : c && c.group === "boolean" ? "true / false" : "Empty",
            "aria-label": `Value for ${p.column}`,
            oninput: (e) => { p.value = e.target.value; p.dirty = true; e.target.closest(".pill").classList.add("dirty"); },
            onkeydown: (e) => { if (e.key === "Enter") applyPills(); },
          }),
          apply, remove));
      }
    });
    bar.replaceChildren(...nodes);
    renderToolbarFilterState();
  }
  function renderToolbarFilterState() { if (T()) $("#filter-btn").classList.toggle("active", S.filter.filters.length > 0 || S.pills.length > 0); }
  function applyPills() {
    if (!confirmDiscard()) return;
    // a pill is applied once it is complete; an empty value only makes sense for text columns
    const complete = (p) => {
      if (p.kind === "SqlFilter") return !!p.sql.trim();
      if (p.kind !== "ColumnFilter" || !p.operator) return false;
      if (NO_VALUE.has(p.operator) || String(p.value ?? "").trim() !== "") return true;
      const c = T().columns.find((x) => x.name === p.column);
      return !!c && c.group === "string" && !["in", "like"].includes(p.operator);
    };
    const ready = S.pills.filter(complete);
    S.filter = {
      kind: "FilterGroup", id: "root", after: "and",
      filters: ready.map((p) => (p.kind === "SqlFilter"
        ? { kind: "SqlFilter", id: p.id, sql: p.sql, after: p.after || "and" }
        : { kind: "ColumnFilter", id: p.id, column: p.column, operator: p.operator, value: NO_VALUE.has(p.operator) ? null : p.value, after: p.after || "and" })),
    };
    S.pills.forEach((p) => (p.dirty = false));
    S.page = 0;
    resetPending();
    writeHash();
    renderFilterBar();
    load();
  }

  /* ================================================================ */
  /* VISUALIZER                                                       */
  /* ================================================================ */
  const vz = { x: 40, y: 30, k: 1, positions: store.get("viz", {}), fitted: false };
  function enterVisualizer() {
    renderErd();
    loadDrift(false);
  }
  function autoLayout(tables) {
    // rank = depth along foreign keys (referenced tables on top), like a top-down hierarchy
    const byId = new Map(tables.map((t) => [t.id, t]));
    const rank = new Map();
    const visiting = new Set();
    const rankOf = (id) => {
      if (rank.has(id)) return rank.get(id);
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const refs = [...new Set(byId.get(id).columns.filter((c) => c.fk && c.fk.entity !== id && byId.has(c.fk.entity)).map((c) => c.fk.entity))];
      const r = refs.length ? 1 + Math.max(...refs.map(rankOf)) : 0;
      visiting.delete(id);
      rank.set(id, r);
      return r;
    };
    tables.forEach((t) => rankOf(t.id));
    const rows = [];
    for (const t of tables) (rows[rank.get(t.id)] ||= []).push(t);
    const W = 200, GX = 60, GY = 70;
    const height = (t) => 36 + t.columns.length * 20 + (t.relations.length ? 22 : 0);
    const maxPerRow = Math.max(...rows.map((r) => (r ? r.length : 0)));
    const pos = {};
    let y = 0;
    rows.forEach((row) => {
      if (!row) return;
      row.sort((a, b) => a.tableName.localeCompare(b.tableName));
      const offset = ((maxPerRow - row.length) * (W + GX)) / 2;
      row.forEach((t, i) => (pos[t.id] = { x: offset + i * (W + GX), y }));
      y += Math.max(...row.map(height)) + GY;
    });
    return pos;
  }
  function renderErd() {
    const stage = $("#viz-stage");
    const tables = S.meta.tables.filter((t) => schemaOf(t) === S.schema);
    const auto = autoLayout(tables);
    stage.querySelectorAll(".erd").forEach((n) => n.remove());
    for (const t of tables) {
      const p = vz.positions[t.id] || auto[t.id];
      const cols = [...t.columns].sort((a, b) => (b.isPrimary - a.isPrimary));
      const card = el("div", { class: "erd", "data-id": t.id, style: { left: p.x + "px", top: p.y + "px" } },
        el("header", {}, el("span", { text: t.tableName }), el("button", { class: "open", title: `Open ${t.tableName}`, "aria-label": `Open ${t.tableName}`, onclick: () => openTable(t.id) }, ico("open"))),
        cols.map((c) => el("div", { class: "row" + (c.isPrimary ? " pk" : "") + (c.fk ? " fk" : ""), "data-col": c.name, title: c.fk ? `→ ${c.fk.entity}.${c.fk.column}` : c.dbType || c.type },
          el("span", { class: "marks" }, c.nullable ? el("span", { class: "key nul", text: "?" }) : null, c.isPrimary ? el("span", { class: "key pk" }) : null, c.fk ? el("span", { class: "key fk" }) : null),
          el("span", { class: "n", text: c.name }),
          el("span", { class: "t", text: c.dbType || c.type }))),
        t.relations.length ? el("div", { class: "rels", text: t.relations.map((r) => `${r.name} → ${r.target}`).join(" · ") }) : null);
      card.addEventListener("mouseenter", () => hl(t.id, true));
      card.addEventListener("mouseleave", () => hl(t.id, false));
      card.addEventListener("dblclick", () => openTable(t.id));
      dragCard(card, t.id);
      stage.append(card);
    }
    applyTransform();
    requestAnimationFrame(() => { if (!vz.fitted) { fitView(); vz.fitted = true; } drawLines(); });
  }
  function hl(id, on) {
    document.querySelectorAll("#viz-lines path").forEach((p) => { if (p.dataset.a === id || p.dataset.b === id) p.classList.toggle("hl", on); });
    document.querySelectorAll(`.erd[data-id="${CSS.escape(id)}"]`).forEach((c) => c.classList.toggle("hl", on));
  }
  function applyTransform() { $("#viz-stage").style.transform = `translate(${vz.x}px, ${vz.y}px) scale(${vz.k})`; }
  function fitView() {
    const cards = [...document.querySelectorAll("#viz-stage .erd")];
    if (!cards.length) return;
    const minX = Math.min(...cards.map((c) => c.offsetLeft)), minY = Math.min(...cards.map((c) => c.offsetTop));
    const maxX = Math.max(...cards.map((c) => c.offsetLeft + c.offsetWidth)), maxY = Math.max(...cards.map((c) => c.offsetTop + c.offsetHeight));
    const box = $("#viz").getBoundingClientRect();
    const k = Math.min(1.2, Math.max(0.25, Math.min((box.width - 80) / (maxX - minX || 1), (box.height - 80) / (maxY - minY || 1))));
    vz.k = k;
    vz.x = (box.width - (maxX - minX) * k) / 2 - minX * k;
    vz.y = (box.height - (maxY - minY) * k) / 2 - minY * k;
    applyTransform();
  }
  function zoomAt(factor, cx, cy) {
    const k = Math.min(2.5, Math.max(0.2, vz.k * factor));
    vz.x = cx - ((cx - vz.x) * k) / vz.k;
    vz.y = cy - ((cy - vz.y) * k) / vz.k;
    vz.k = k;
    applyTransform();
  }
  function drawLines() {
    if (S.view !== "visualizer") return;
    const svg = $("#viz-lines");
    const NS = "http://www.w3.org/2000/svg";
    svg.replaceChildren();
    const anchor = (id, col) => {
      const card = document.querySelector(`#viz-stage .erd[data-id="${CSS.escape(id)}"]`);
      if (!card) return null;
      const row = card.querySelector(`.row[data-col="${CSS.escape(col)}"]`) || card.querySelector("header");
      return { l: card.offsetLeft, r: card.offsetLeft + card.offsetWidth, t: card.offsetTop, b: card.offsetTop + card.offsetHeight, cx: card.offsetLeft + card.offsetWidth / 2, y: card.offsetTop + row.offsetTop + row.offsetHeight / 2 };
    };
    for (const t of S.meta.tables) {
      for (const c of t.columns) {
        if (!c.fk) continue;
        const a = anchor(t.id, c.name), b = anchor(c.fk.entity, c.fk.column);
        if (!a || !b) continue;
        let d, lx, ly;
        if (t.id === c.fk.entity) {
          d = `M${a.r},${a.y} C${a.r + 40},${a.y} ${b.r + 40},${b.y} ${b.r},${b.y}`;
          lx = a.r + 30; ly = (a.y + b.y) / 2;
        } else if (a.t >= b.b || b.t >= a.b) {
          // vertical layout: leave from top/bottom edges with an orthogonal elbow
          const down = a.t >= b.b; // child below parent
          const y1 = down ? a.t : a.b, y2 = down ? b.b : b.t;
          const mid = (y1 + y2) / 2;
          d = `M${a.cx},${y1} L${a.cx},${mid} L${b.cx},${mid} L${b.cx},${y2}`;
          lx = (a.cx + b.cx) / 2; ly = mid;
        } else {
          const ltr = a.r < b.l;
          const x1 = ltr ? a.r : a.l, x2 = ltr ? b.l : b.r, mid = (x1 + x2) / 2;
          d = `M${x1},${a.y} L${mid},${a.y} L${mid},${b.y} L${x2},${b.y}`;
          lx = mid; ly = (a.y + b.y) / 2;
        }
        const path = document.createElementNS(NS, "path");
        path.setAttribute("d", d);
        path.dataset.a = t.id;
        path.dataset.b = c.fk.entity;
        const title = document.createElementNS(NS, "title");
        title.textContent = `${t.tableName}.${c.name} → ${c.fk.entity}.${c.fk.column}`;
        path.append(title);
        svg.append(path);
        const rel = t.relations.find((r) => r.name === c.fk.relation);
        const label = rel && rel.kind === "one-to-one" ? "1:1" : rel && rel.kind === "many-to-many" ? "n:m" : "1:n";
        const g = document.createElementNS(NS, "g");
        g.setAttribute("class", "card-label");
        const rect = document.createElementNS(NS, "rect");
        rect.setAttribute("x", lx - 11); rect.setAttribute("y", ly - 7); rect.setAttribute("width", 22); rect.setAttribute("height", 14); rect.setAttribute("rx", 3);
        const text = document.createElementNS(NS, "text");
        text.setAttribute("x", lx); text.setAttribute("y", ly + 3); text.setAttribute("text-anchor", "middle");
        text.textContent = label;
        g.append(rect, text);
        svg.append(g);
      }
    }
  }
  function dragCard(card, id) {
    const header = card.querySelector("header");
    header.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      e.preventDefault();
      e.stopPropagation();
      header.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY, ox = card.offsetLeft, oy = card.offsetTop;
      const move = (ev) => { card.style.left = ox + (ev.clientX - sx) / vz.k + "px"; card.style.top = oy + (ev.clientY - sy) / vz.k + "px"; drawLines(); };
      const up = () => {
        header.removeEventListener("pointermove", move);
        header.removeEventListener("pointerup", up);
        vz.positions[id] = { x: card.offsetLeft, y: card.offsetTop };
        store.set("viz", vz.positions);
      };
      header.addEventListener("pointermove", move);
      header.addEventListener("pointerup", up);
    });
  }
  function wireVisualizer() {
    const viz = $("#viz");
    viz.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".erd, .viz-zoom")) return;
      viz.setPointerCapture(e.pointerId);
      viz.classList.add("panning");
      const sx = e.clientX - vz.x, sy = e.clientY - vz.y;
      const move = (ev) => { vz.x = ev.clientX - sx; vz.y = ev.clientY - sy; applyTransform(); };
      const up = () => { viz.classList.remove("panning"); viz.removeEventListener("pointermove", move); viz.removeEventListener("pointerup", up); };
      viz.addEventListener("pointermove", move);
      viz.addEventListener("pointerup", up);
    });
    viz.addEventListener("wheel", (e) => {
      e.preventDefault();
      const b = viz.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - b.left, e.clientY - b.top);
    }, { passive: false });
    viz.addEventListener("keydown", (e) => {
      const b = viz.getBoundingClientRect();
      if (e.key === "+" || e.key === "=") zoomAt(1.2, b.width / 2, b.height / 2);
      else if (e.key === "-") zoomAt(1 / 1.2, b.width / 2, b.height / 2);
      else if (e.key === "0") fitView();
      else if (e.key.startsWith("Arrow")) { const d = 40; if (e.key === "ArrowLeft") vz.x += d; if (e.key === "ArrowRight") vz.x -= d; if (e.key === "ArrowUp") vz.y += d; if (e.key === "ArrowDown") vz.y -= d; applyTransform(); }
    });
    $("#zoom-in").onclick = () => { const b = viz.getBoundingClientRect(); zoomAt(1.2, b.width / 2, b.height / 2); };
    $("#zoom-out").onclick = () => { const b = viz.getBoundingClientRect(); zoomAt(1 / 1.2, b.width / 2, b.height / 2); };
    $("#zoom-fit").onclick = fitView;
    $("#drift-btn").onclick = () => { const p = $("#drift-panel"); p.classList.toggle("hidden"); if (!p.classList.contains("hidden")) loadDrift(true); };
  }
  async function loadDrift(render) {
    const panel = $("#drift-panel");
    if (render) panel.replaceChildren(el("p", { class: "note", text: "Comparing entities with the database…" }));
    const [diff, mig] = await Promise.allSettled([call("schema-diff"), render ? call("migrations") : Promise.resolve(null)]);
    if (diff.status === "fulfilled") {
      const n = diff.value.up.length;
      $("#drift-badge").classList.toggle("hidden", diff.value.inSync);
      $("#drift-badge").textContent = String(n);
    }
    if (!render) return;
    const parts = [el("h2", { text: "Database vs. entities" })];
    if (diff.status === "fulfilled") {
      const d = diff.value;
      parts.push(el("p", {}, el("span", { class: "status-pill " + (d.inSync ? "ok" : "warn"), text: d.inSync ? "In sync" : `${plural(d.up.length, "pending change")}` }), " ",
        el("span", { class: "note", text: d.inSync ? "The database matches your entities." : "SQL that synchronize (or a generated migration) would run:" })));
      if (!d.inSync) {
        const sql = d.up.map((q) => q.query.trim() + ";").join("\n");
        parts.push(...d.up.map((q) => el("pre", { class: "ddl", text: q.query.trim() + ";" })));
        parts.push(el("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
          el("button", { class: "btn", onclick: () => navigator.clipboard.writeText(sql).then(() => toast("Copied SQL"), () => toast("Clipboard unavailable", true)) }, ico("copy"), "Copy SQL"),
          S.caps.sqlEditor ? el("button", { class: "btn", onclick: () => openSqlWith(sql) }, "Open in SQL") : null));
        parts.push(el("p", { class: "note", text: "`npx typeorm migration:generate -d <data-source> <Name>` turns this into a migration." }));
      }
    } else parts.push(el("p", { class: "err", text: diff.reason.message }));
    parts.push(el("h2", { text: "Migrations" }));
    if (mig.status === "fulfilled" && mig.value) {
      const m = mig.value;
      if (!m.configured) parts.push(el("p", { class: "note", text: "No migrations are registered on this DataSource." }));
      else {
        const pending = m.migrations.filter((x) => !x.executed).length;
        parts.push(el("p", {}, el("span", { class: "status-pill " + (pending ? "warn" : "ok"), text: pending ? `${pending} pending` : "All executed" })));
        parts.push(...m.migrations.map((x) => el("div", { class: "mig" }, el("span", { class: "mono", text: x.name }), el("span", { class: x.executed ? "note" : "err", text: x.executed ? "executed" : "pending" }))));
      }
    } else if (mig.status === "rejected") parts.push(el("p", { class: "err", text: mig.reason.message }));
    panel.replaceChildren(...parts);
  }

  /* ================================================================ */
  /* CONSOLE (log of Studio operations and the SQL they ran)          */
  /* ================================================================ */
  function renderConsole(append = false) {
    const box = $("#console");
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    const time = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    const query = (q) => {
      const sqlBox = el("div", { class: "box clamp", text: q.sql });
      const toggle = el("button", { class: "op-toggle", "aria-expanded": "false", onclick: () => {
        const open = toggle.getAttribute("aria-expanded") !== "true";
        toggle.setAttribute("aria-expanded", String(open));
        sqlBox.classList.toggle("clamp", !open);
      } }, el("span", { class: "chev", text: "›" }), "SQL Query", q.error ? el("span", { class: "err", text: " · failed" }) : null);
      return el("div", { class: "op-q" },
        el("div", { class: "op-qhead" }, toggle,
          el("button", { class: "icon-btn bare", title: "Copy SQL", "aria-label": "Copy SQL", onclick: () => navigator.clipboard.writeText(q.sql).then(() => toast("Copied SQL"), () => toast("Clipboard unavailable", true)) }, ico("copy"))),
        sqlBox,
        el("div", { class: "lbl", text: "Parameters" }),
        el("div", { class: "box", text: JSON.stringify(q.parameters) }),
        el("div", { class: "meta", text: `${q.durationMs} ms${q.error ? " · " + q.error : ""}` }));
    };
    const card = (op) => el("div", { class: "op" + (op.ok ? "" : " err") },
      el("div", { class: "op-head" }, ico(op.ok ? "ok" : "err"), `${op.procedure}, ${time(op.at)}`, el("span", { class: "status", text: op.ok ? "Success" : "Error" })),
      op.error ? el("div", { class: "op-err", text: op.error }) : null,
      op.queries.map(query));
    if (!S.log.length) {
      box.replaceChildren(el("div", { class: "empty-note", text: "Operations Studio runs, and the SQL behind them, appear here." }));
      return;
    }
    if (append && box.querySelector(".op")) box.append(card(S.log[S.log.length - 1]));
    else box.replaceChildren(...S.log.map(card));
    if (atBottom || !append) box.scrollTop = box.scrollHeight;
  }

  /* ================================================================ */
  /* SQL                                                              */
  /* ================================================================ */
  let editor = null;
  let lastResult = null;
  function enterSql() {
    if (!editor) {
      const host = $("#sql-editor");
      const initial = store.get(draftKey(), isMongo() ? "db.getCollectionNames()" : "SELECT 1;");
      if (window.StudioCM) {
        editor = window.StudioCM.createSqlEditor(host, {
          doc: initial, dialect: "standard", onRun: runSql,
          lint: S.caps.sqlLint ? (sql) => call("sql-lint", { sql }).then((r) => r.diagnostics) : null,
        });
        editor.view.dom.addEventListener("keyup", () => store.set(draftKey(), editor.getValue()));
        call("sql-schema").then((s) => editor.setSchema(s.dialect, s.namespace)).catch(() => undefined);
      } else {
        const ta = el("textarea", { spellcheck: "false", style: { width: "100%", height: "100%", border: "0", padding: "12px", background: "var(--bg)", fontFamily: "var(--mono)" } });
        ta.value = initial;
        ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runSql(); } });
        host.append(ta);
        editor = { getValue: () => ta.value, setValue: (v) => (ta.value = v), getSelection: () => ta.value.slice(ta.selectionStart, ta.selectionEnd), focus: () => ta.focus() };
      }
      renderHistory();
    }
    setTimeout(() => editor.focus(), 0);
  }
  function openSqlWith(sql) {
    S.view = "sql";
    writeHash(true);
    showView();
    editor.setValue(sql);
    store.set(draftKey(), sql);
  }
  function renderHistory() {
    const h = store.get(historyKey(), []);
    $("#sql-history").replaceChildren(el("option", { value: "", text: h.length ? `History (${h.length})` : "History" }), ...h.map((q, i) => el("option", { value: String(i), text: q.replace(/\s+/g, " ").slice(0, 90) })));
  }
  async function runSql() {
    const sel = editor.getSelection();
    const sql = (sel && sel.trim()) || editor.getValue().trim();
    if (!sql) return;
    store.set(draftKey(), editor.getValue());
    $("#sql-status").textContent = "Running…";
    $("#sql-run").disabled = true;
    try {
      const r = await call("raw", { sql });
      lastResult = r.rows;
      const cols = [...new Set(r.rows.flatMap((x) => Object.keys(x)))];
      $("#sql-grid").replaceChildren(
        el("thead", {}, el("tr", {}, cols.map((c) => el("th", { text: c })))),
        el("tbody", {}, r.rows.slice(0, 5000).map((row) => el("tr", {}, cols.map((c) => el("td", { title: asText(row[c]) }, format(null, row[c])))))));
      $("#sql-status").textContent = `${r.rows.length ? plural(r.rows.length, "row") + (r.rows.length > 5000 ? " (showing 5,000)" : "") : "Done" + (r.rowCount ? ` · ${r.rowCount} affected` : "")} · ${r.durationMs} ms${sel && sel.trim() ? " · selection" : ""}`;
      $("#sql-export").disabled = !r.rows.length;
      const h = store.get(historyKey(), []).filter((q) => q !== sql);
      h.unshift(sql);
      store.set(historyKey(), h.slice(0, 50));
      renderHistory();
    } catch (e) {
      $("#sql-status").textContent = "";
      $("#sql-grid").replaceChildren();
      $("#sql-export").disabled = true;
      toast(e.message, true);
    } finally {
      $("#sql-run").disabled = false;
    }
  }
  function exportCsv() {
    if (!lastResult || !lastResult.length) return;
    const cols = [...new Set(lastResult.flatMap((x) => Object.keys(x)))];
    const esc = (v) => { const s = asText(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.join(","), ...lastResult.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
    const a = el("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: "query-result.csv" });
    document.body.append(a);
    a.click();
    a.remove();
  }

  /* ================================================================ */
  /* QUERIES (insights)                                               */
  /* ================================================================ */
  let insightsTimer = null;
  function stopInsightsPolling() { clearInterval(insightsTimer); insightsTimer = null; }
  function enterInsights() {
    loadInsights();
    stopInsightsPolling();
    if ($("#q-live").checked) insightsTimer = setInterval(() => { if (!document.hidden) loadInsights(); }, 2000);
  }
  async function loadInsights(reset = false) {
    try {
      renderInsights(await call("insights", { includeStudio: $("#q-studio").checked, reset, limit: 300 }));
    } catch (e) {
      stopInsightsPolling();
      $("#q-grid").replaceChildren();
      $("#q-empty").classList.remove("hidden");
      $("#q-empty").textContent = e.message;
    }
  }
  function renderInsights(snap) {
    const filter = $("#q-filter").value.trim().toLowerCase();
    const qs = snap.queries.filter((q) => !filter || q.query.toLowerCase().includes(filter) || q.tables.some((t) => t.toLowerCase().includes(filter)));
    const maxTotal = Math.max(1, ...qs.map((q) => q.duration));
    $("#q-summary").textContent = `${snap.totalQueries.toLocaleString()} queries since ${new Date(snap.since).toLocaleTimeString()}`;
    const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
    $("#q-grid").replaceChildren(
      el("thead", {}, el("tr", {}, el("th", { text: "query" }), el("th", { text: "tables" }), ...["calls", "total ms", "avg ms", "max ms", "rows"].map((h) => el("th", { class: "num", text: h })), el("th", { text: "last seen" }))),
      el("tbody", {}, qs.map((q) => {
        const avg = q.duration / q.count;
        return el("tr", { class: avg > 100 ? "slow" : "", title: S.caps.sqlEditor ? "Open in the SQL view" : "", onclick: () => { if (S.caps.sqlEditor) openSqlWith(q.query.replace(/\(\?…\)/g, "(?)")); } },
          el("td", { class: "q" }, q.source === "studio" ? el("span", { class: "src", text: "studio" }) : null, q.source === "studio" ? " " : null, q.query,
            q.errors ? el("div", { class: "err", text: `${plural(q.errors, "error")}: ${q.lastError}` }) : null,
            el("div", { class: "bar", style: { width: Math.max(2, (q.duration / maxTotal) * 100) + "%" } })),
          el("td", { text: q.tables.join(", ") }),
          el("td", { class: "num", text: q.count.toLocaleString() }),
          el("td", { class: "num", text: q.duration.toFixed(1) }),
          el("td", { class: "num avg", text: avg.toFixed(2) }),
          el("td", { class: "num", text: q.maxDurationMs.toFixed(1) }),
          el("td", { class: "num", text: q.rowsReturned.toLocaleString() }),
          el("td", { class: "muted", text: ago(q.lastSeen) }));
      })));
    $("#q-empty").classList.toggle("hidden", qs.length > 0);
    $("#q-empty").textContent = snap.queries.length ? "No queries match the filter." : "No queries recorded yet. Queries your app runs through this DataSource appear here when Studio is embedded with createStudioHandler; tick “Include Studio's own queries” to see Studio's.";
  }

  /* ================================================================ */
  /* wiring                                                           */
  /* ================================================================ */
  function wire() {
    document.querySelectorAll(".sidebar-toggle").forEach((b) => (b.onclick = toggleSidebar));
    wireSidebarResize();
    document.querySelectorAll("#views a").forEach((a) => (a.onclick = (e) => { e.preventDefault(); setView(a.dataset.view); }));
    $("#schema").onchange = (e) => { S.schema = e.target.value; renderSidebar(); if (S.view === "visualizer") { vz.fitted = false; renderErd(); } };
    $("#tables-search-btn").onclick = () => { const w = $("#tables-search-wrap"); w.classList.toggle("hidden"); if (!w.classList.contains("hidden")) $("#tables-search").focus(); else { $("#tables-search").value = ""; renderSidebar(); } };
    $("#tables-search").addEventListener("input", renderSidebar);
    $("#tables-search").addEventListener("keydown", (e) => { if (e.key === "Escape") { $("#tables-search").value = ""; $("#tables-search-wrap").classList.add("hidden"); renderSidebar(); } });
    $("#tables-refresh").onclick = async () => { await bootMeta(); renderSchemas(); renderSidebar(); toast("Tables refreshed"); };

    $("#search-btn").onclick = () => { $("#search-field").classList.remove("hidden"); $("#search-btn").classList.add("hidden"); $("#search").focus(); };
    const runSearch = debounce(() => { if (!T() || !confirmDiscard()) return; S.search = $("#search").value; S.page = 0; resetPending(); writeHash(); load(); }, 300);
    $("#search").addEventListener("input", runSearch);
    const clearSearch = () => { $("#search").value = ""; if (S.search) { S.search = ""; S.page = 0; resetPending(); writeHash(); load(); } syncSearchUi(); };
    $("#search-clear").onclick = clearSearch;
    $("#search").addEventListener("keydown", (e) => { if (e.key === "Escape") clearSearch(); });
    $("#filter-btn").onclick = openFilterMenu;
    $("#insert-btn").onclick = insertRow;
    $("#copy-btn").onclick = openCopyMenu;
    $("#save-btn").onclick = save;
    $("#discard-btn").onclick = () => { resetPending(); render(); };
    $("#delete-btn").onclick = deleteSelected;
    $("#refresh-btn").onclick = () => T() && confirmDiscard() && (resetPending(), load());

    const goPage = (p) => { if (!confirmDiscard()) return; const pages = Math.max(1, Math.ceil(S.total / S.size)); S.page = Math.min(pages - 1, Math.max(0, p)); resetPending(); writeHash(); load(); };
    $("#pg-first").onclick = () => goPage(0);
    $("#pg-prev").onclick = () => goPage(S.page - 1);
    $("#pg-next").onclick = () => goPage(S.page + 1);
    $("#pg-last").onclick = () => goPage(Math.ceil(S.total / S.size) - 1);
    $("#pg-input").addEventListener("keydown", (e) => { if (e.key === "Enter") goPage(Number(e.target.value) - 1 || 0); });
    $("#pg-input").addEventListener("blur", (e) => (e.target.value = String(S.page + 1)));
    $("#pg-size").onchange = (e) => { if (!confirmDiscard()) { e.target.value = String(S.size); return; } S.size = Number(e.target.value); S.page = 0; resetPending(); writeHash(); load(); };
    $("#infinite").onchange = (e) => { if (!confirmDiscard()) { e.target.checked = S.infinite; return; } S.infinite = e.target.checked; store.set("infinite", S.infinite); S.page = 0; resetPending(); writeHash(); load(); };
    $("#grid-wrap").addEventListener("scroll", () => {
      const w = $("#grid-wrap");
      if (!S.infinite || S.loadingMore || S.rows.length >= S.total) return;
      if (w.scrollTop + w.clientHeight >= w.scrollHeight - 200) { S.loadingMore = true; load({ append: true }); }
    });
    $("#grid-wrap").addEventListener("scroll", followAnchor);

    $("#sql-run").onclick = runSql;
    $("#sql-export").onclick = exportCsv;
    $("#sql-history").onchange = (e) => { const h = store.get(historyKey(), []); if (e.target.value !== "") { editor.setValue(h[+e.target.value]); editor.focus(); } e.target.value = ""; };

    $("#console-clear").onclick = () => { S.log = []; renderConsole(); };
    $("#q-reset").onclick = () => loadInsights(true);
    $("#q-studio").onchange = () => loadInsights();
    $("#q-live").onchange = () => enterInsights();
    $("#q-filter").addEventListener("input", debounce(() => loadInsights(), 150));
    wireVisualizer();

    document.addEventListener("keydown", onGridKey);
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    window.addEventListener("resize", debounce(() => { closeFloating(); if (S.view === "visualizer") drawLines(); if (S.view === "table" && T()) renderGrid(); }, 100));
    window.addEventListener("hashchange", () => {
      readHash();
      if (!S.table || !T()) S.table = firstTable();
      resetPending();
      pillsFromFilter();
      syncSearchUi();
      renderSchemas();
      showView();
      writeHash();
    });
    window.addEventListener("beforeunload", (e) => { if (hasPending()) { e.preventDefault(); e.returnValue = ""; } });
  }
  function firstTable() {
    const inSchema = S.meta.tables.filter((t) => !S.schema || schemaOf(t) === S.schema).sort((a, b) => a.tableName.localeCompare(b.tableName));
    return (inSchema.find((t) => t.kind === "entity") || inSchema[0] || S.meta.tables[0] || {}).id || null;
  }
  async function bootMeta() {
    S.meta = await call("introspect");
    S.caps = S.meta.capabilities || {};
    S.tables = new Map(S.meta.tables.map((t) => [t.id, t]));
  }
  async function boot() {
    if (store.get("collapsed", false)) $("#app").classList.add("collapsed");
    wire();
    try {
      await bootMeta();
    } catch (e) {
      toast(`Could not load the schema: ${e.message}`, true);
      return;
    }
    $("#conn").textContent = `${S.meta.driver}${S.meta.database ? " · " + S.meta.database : ""}${S.meta.readOnly ? " · read-only" : ""}`;
    $("#conn").title = $("#conn").textContent;
    $("#nav-sql").classList.toggle("hidden", !S.caps.sqlEditor);
    $("#nav-queries").classList.toggle("hidden", !S.caps.insights);
    $("#drift-btn").classList.toggle("hidden", S.caps.schemaDiff === false);
    if (isMongo()) {
      $("#nav-sql").textContent = "Query";
      $("#sql-run").replaceChildren(ico("play"), " Run");
    }
    readHash();
    if (S.view === "sql" && !S.caps.sqlEditor) S.view = "table";
    renderSchemas();
    if (!S.table) S.table = firstTable();
    pillsFromFilter();
    syncSearchUi();
    writeHash();
    showView();
    // surface schema drift on the Visualizer button without opening it
    if (S.caps.schemaDiff !== false) loadDrift(false).catch(() => undefined);
  }

  boot();
})();
