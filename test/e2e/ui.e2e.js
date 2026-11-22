// Browser test of the Studio UI. Needs a running Studio on the seeded example DB:
//   npm run seed && npm run studio:example   (then)   node test/e2e/ui.e2e.js
// BASE=http://127.0.0.1:5555/ by default. Uses Playwright (not a dependency of the package).
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://127.0.0.1:5555/";

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  page.on("dialog", (d) => d.accept());
  let fails = 0;
  const step = async (name, fn) => {
    try { await fn(); console.log("ok  ", name); } catch (e) { fails++; console.log("FAIL", name, "-", e.message.split("\n")[0]); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const go = async (hash) => { await page.goto(BASE + hash); await page.waitForTimeout(900); };
  const cell = (r, c) => page.locator(`#grid td[data-r="${r}"][data-c="${c}"]`);
  const colIndex = async (name) => (await page.$$eval("#grid thead th", (ths) => ths.map((th) => th.querySelector(".name")?.textContent))).indexOf(name) - 1;
  const rowCount = () => page.locator("#grid tbody tr").count();
  const counter = () => page.textContent("#row-count");

  await step("opens the first table with typed values and Prisma-style headers", async () => {
    await go("");
    await page.waitForSelector("#grid tbody tr");
    assert(/table=post/.test(page.url()), page.url());
    const heads = await page.$$eval("#grid thead th .name", (n) => n.map((x) => x.textContent));
    assert(heads[0] === "id" && heads[1] === "authorId", "PK first, then alphabetical: " + heads.join(","));
    assert((await page.locator("#grid th .req").count()) >= 1, "required marker");
    const pub = (await cell(0, await colIndex("published")).textContent()).trim();
    assert(pub === "true" || pub === "false", "boolean " + pub);
    const d = (await cell(0, await colIndex("createdAt")).textContent()).trim();
    assert(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(d), "ISO date " + d);
    assert(/1–25 of 56/.test(await counter()), await counter());
  });

  await step("sidebar: tables list, table search, views", async () => {
    await page.click("#tables-search-btn");
    await page.fill("#tables-search", "pro");
    assert((await page.locator("#tables a").count()) === 1, "filtered");
    await page.keyboard.press("Escape");
    assert((await page.locator("#tables a").count()) === 5, "restored");
    await page.click('#tables a:has-text("user")');
    await page.waitForTimeout(500);
    assert(/table=user/.test(page.url()), page.url());
  });

  await step("search expands, highlights matches and clears", async () => {
    await go("#table=post&view=table");
    await page.click("#search-btn");
    await page.keyboard.type("hamilton");
    await page.waitForTimeout(700);
    assert(/of 13 rows/.test(await counter()), await counter());
    assert((await page.locator("#grid mark").count()) >= 13, "highlights");
    await page.click("#search-clear");
    await page.waitForTimeout(500);
    assert(/of 56 rows/.test(await counter()), await counter());
  });

  await step("filter: column menu → operator menu → value → pill; AND/OR; remove", async () => {
    await page.click("#filter-btn");
    await page.keyboard.type("views");
    await page.keyboard.press("Enter");
    await page.keyboard.type("greater than or");
    await page.keyboard.press("Enter");
    await page.keyboard.type("400");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const n1 = await counter();
    assert(/of \d+ rows/.test(n1), n1);
    await page.click("#filter-btn");
    await page.keyboard.type("published");
    await page.keyboard.press("Enter");
    await page.keyboard.type("equal");
    await page.keyboard.press("Enter");
    await page.keyboard.type("true");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const n2 = await counter();
    assert(Number(n2.match(/of (\d+)/)[1]) < Number(n1.match(/of (\d+)/)[1]), `AND narrows: ${n1} -> ${n2}`);
    await page.click(".pill .join");
    await page.waitForTimeout(500);
    const n3 = await counter();
    assert(Number(n3.match(/of (\d+)/)[1]) > Number(n1.match(/of (\d+)/)[1]), `OR widens: ${n3}`);
    assert(/filter=/.test(page.url()), "filter in URL");
    await page.locator(".pill .remove").last().click();
    await page.locator(".pill .remove").last().click();
    await page.waitForTimeout(500);
    assert(/of 56 rows/.test(await counter()), await counter());
  });

  await step("filter: SQL WHERE clause pill", async () => {
    await page.click("#filter-btn");
    await page.keyboard.type("sql where");
    await page.keyboard.press("Enter");
    await page.keyboard.type("views < 30"); // unquoted: portable across Postgres, MySQL and SQLite
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    assert(/of \d+ rows/.test(await counter()) && !/of 56/.test(await counter()), await counter());
    await page.locator(".pill .remove").click();
    await page.waitForTimeout(400);
  });

  await step("sort and pin from the header controls", async () => {
    const th = page.locator("#grid thead th", { has: page.locator('.name:text-is("views")') });
    await th.hover();
    await th.locator('button[aria-label="Sort ascending"]').click();
    await page.waitForTimeout(400);
    await th.hover();
    await th.locator('button[aria-label="Sort descending"]').click();
    await page.waitForTimeout(500);
    assert(/sort=views%3Adesc|sort=views:desc/.test(page.url()), page.url());
    assert((await cell(0, await colIndex("views")).textContent()).trim() === "840", "desc sort");
    await th.hover();
    await th.locator('button[aria-label="Pin column"]').click();
    assert((await colIndex("views")) === 0, "pinned first");
    assert(await page.locator("#grid thead th.pinned").count() === 1, "sticky");
    await page.locator("#grid thead th.pinned").hover();
    await page.locator('#grid thead th.pinned button[aria-label="Unpin column"]').click();
  });

  await step("popover editors: text, boolean, datetime, NULL; Save N rows", async () => {
    await go("#table=post&view=table&sort=views:desc");
    const t = await colIndex("title"), b = await colIndex("published"), d = await colIndex("updatedAt"), body = await colIndex("body");
    await cell(0, t).dblclick();
    await page.waitForSelector("#popover textarea");
    await page.fill("#popover textarea", "Edited in Studio");
    await page.keyboard.press("Enter");
    await cell(1, b).dblclick();
    const before = (await cell(1, b).textContent()).trim();
    await page.locator("#popover .opt-list button", { hasText: before === "true" ? "false" : "true" }).click();
    await cell(2, d).dblclick();
    await page.locator("#popover button", { hasText: "Now" }).click();
    await cell(3, body).dblclick();
    await page.locator("#popover button", { hasText: "Set NULL" }).click();
    assert((await page.locator("#grid td.edited").count()) >= 3, "edited cells highlighted");
    const label = await page.textContent("#save-btn");
    assert(/Save 4 rows/.test(label), label);
    await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + "/e2e-edits.png" : "/dev/null" }).catch(() => {});
    await page.click("#save-btn");
    await page.waitForTimeout(700);
    assert(await page.locator("#save-btn").isHidden(), "saved");
    assert((await cell(0, t).textContent()).trim() === "Edited in Studio", "persisted");
  });

  await step("Esc cancels an edit; Discard edits drops staged changes", async () => {
    const t = await colIndex("title");
    await cell(4, t).dblclick();
    await page.fill("#popover textarea", "nope");
    await page.keyboard.press("Escape");
    assert(!(await page.locator("#save-btn").isVisible()), "cancelled");
    await cell(4, t).click();
    await page.keyboard.type("x");
    await page.keyboard.press("Enter");
    assert(await page.locator("#discard-btn").isVisible(), "staged");
    await page.click("#discard-btn");
    assert(await page.locator("#discard-btn").isHidden(), "discarded");
  });

  await step("keyboard navigation, range copy and paste", async () => {
    const t = await colIndex("title");
    await cell(5, t).click();
    await page.keyboard.press("Shift+ArrowDown");
    assert((await page.locator("#grid td.in-range").count()) === 1, "range");
    await page.keyboard.press("ControlOrMeta+c");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert(clip.split("\n").length === 2, JSON.stringify(clip));
    await cell(10, t).click();
    await page.keyboard.press("ControlOrMeta+v");
    assert((await cell(10, t).textContent()).trim() === clip.split("\n")[0], "pasted");
    assert(/Save 2 rows/.test(await page.textContent("#save-btn")), await page.textContent("#save-btn"));
    await page.click("#discard-btn");
  });

  await step("row selection: copy as JSON, Delete N rows", async () => {
    await page.locator("#grid tbody td.rowsel").nth(0).click();
    await page.locator("#grid tbody td.rowsel").nth(2).click({ modifiers: ["Shift"] });
    assert(/Delete 3 rows/.test(await page.textContent("#delete-btn")), await page.textContent("#delete-btn"));
    await page.click("#copy-btn");
    await page.locator("#menu .m-item", { hasText: "JSON" }).click();
    await page.waitForTimeout(200);
    const json = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    assert(json.length === 3 && "title" in json[0], "copied JSON");
    await page.locator("#grid tbody td.rowsel").nth(1).click();
    await page.locator("#grid tbody td.rowsel").nth(2).click();
    await page.click("#delete-btn");
    await page.waitForTimeout(700);
    assert(/of 55 rows/.test(await counter()), await counter());
  });

  await step("insert row shows placeholders and saves required text as empty string", async () => {
    await go("#table=tag&view=table");
    await page.click("#insert-btn");
    const ph = await page.$$eval("#grid tbody tr.new td", (tds) => tds.map((t) => t.textContent));
    assert(ph.includes("(default value)") && ph.includes("(empty string)"), ph.join("|"));
    await cell(0, await colIndex("label")).dblclick();
    await page.fill("#popover textarea", "e2e");
    await page.keyboard.press("Enter");
    await page.click("#save-btn");
    await page.waitForTimeout(600);
    assert(/of 5 rows/.test(await counter()), await counter());
    await page.click("#insert-btn");
    await page.click("#save-btn");
    await page.waitForTimeout(600);
    assert(/of 6 rows/.test(await counter()), "empty-string label inserted: " + (await counter()));
  });

  await step("relation arrows: FK → parent row, back-reference → children", async () => {
    await go("#table=post&view=table");
    await cell(0, await colIndex("authorId")).locator("button.go").click();
    await page.waitForTimeout(600);
    assert(/table=user/.test(page.url()) && /of 1 rows/.test(await counter()), page.url());
    const postsCol = (await page.$$eval("#grid thead th", (ths) => ths.map((th) => th.textContent.trim()))).findIndex((x) => x === "posts") - 1;
    await cell(0, postsCol).locator("button.go").click();
    await page.waitForTimeout(600);
    assert(/table=post/.test(page.url()) && (await page.locator(".pill").count()) === 1, "filtered children");
  });

  await step("pagination: next/last/first, page input, page size, infinite scroll", async () => {
    await go("#table=post&view=table");
    await page.click("#pg-next"); await page.waitForTimeout(400);
    assert(/26–50/.test(await counter()), await counter());
    await page.click("#pg-last"); await page.waitForTimeout(400);
    assert((await page.inputValue("#pg-input")) === "3", "last page");
    await page.fill("#pg-input", "2"); await page.press("#pg-input", "Enter"); await page.waitForTimeout(400);
    assert(/26–50/.test(await counter()), await counter());
    await page.selectOption("#pg-size", "10"); await page.waitForTimeout(400);
    assert((await rowCount()) === 10, "10 rows");
    await page.selectOption("#pg-size", "25");
    await page.locator("label.toggle", { hasText: "infinite scroll" }).click(); await page.waitForTimeout(500);
    assert((await rowCount()) === 25, "first chunk");
    await page.locator("#grid-wrap").evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(800);
    assert((await rowCount()) === 50, "appended: " + (await rowCount()));
    await page.locator("label.toggle", { hasText: "infinite scroll" }).click(); await page.waitForTimeout(400);
  });

  await step("column resize persists across reloads", async () => {
    const th = page.locator("#grid thead th", { has: page.locator('.name:text-is("body")') });
    const w0 = (await th.boundingBox()).width;
    const hb = await th.locator(".resize").boundingBox();
    await page.mouse.move(hb.x + 2, hb.y + 10); await page.mouse.down();
    await page.mouse.move(hb.x + 150, hb.y + 10, { steps: 5 }); await page.mouse.up();
    await page.reload(); await page.waitForSelector("#grid tbody tr");
    const w1 = (await page.locator("#grid thead th", { has: page.locator('.name:text-is("body")') }).boundingBox()).width;
    assert(Math.abs(w1 - (w0 + 148)) < 6, `${w0} -> ${w1}`);
  });

  await step("visualizer: cards, relation lines, zoom, drift panel", async () => {
    await page.click('#views a[data-view="visualizer"]');
    await page.waitForTimeout(900);
    assert((await page.locator("#viz-stage .erd").count()) === 5, "cards");
    assert((await page.locator("#viz-lines path").count()) >= 4, "lines");
    const t0 = await page.locator("#viz-stage").evaluate((e) => e.style.transform);
    await page.click("#zoom-in");
    const t1 = await page.locator("#viz-stage").evaluate((e) => e.style.transform);
    assert(t0 !== t1, "zoom changes transform");
    await page.click("#drift-btn"); await page.waitForTimeout(800);
    const side = await page.textContent("#drift-panel");
    assert(/In sync|MariaDB 10.10\+/.test(side), side.slice(0, 80));
  });

  await step("console lists operations with their SQL", async () => {
    await page.click('#views a[data-view="console"]');
    await page.waitForTimeout(400);
    // the log is per page session (like Prisma Studio); this session has at least introspect + query
    assert((await page.locator(".op").count()) >= 2, "ops: " + (await page.locator(".op").count()));
    assert((await page.locator(".op-q .box").first().textContent()).length > 10, "sql shown");
    assert(/query, /.test(await page.locator(".op-head").last().textContent()), "labels");
  });

  await step("SQL view: autocomplete, lint, run, history", async () => {
    await page.click('#views a[data-view="sql"]');
    await page.waitForSelector("#sql-editor .cm-editor");
    await page.locator("#sql-editor .cm-content").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("select * fromm post");
    await page.waitForSelector(".cm-lint-marker-error", { timeout: 5000 });
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("select title from po");
    await page.waitForSelector(".cm-tooltip-autocomplete", { timeout: 5000 });
    await page.keyboard.press("Escape");
    await page.keyboard.type("st where views > 500");
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.waitForTimeout(600);
    assert(/rows/.test(await page.textContent("#sql-status")), await page.textContent("#sql-status"));
  });

  await step("Queries view shows grouped statements", async () => {
    await page.click('#views a[data-view="queries"]');
    await page.check("#q-studio");
    await page.waitForTimeout(800);
    assert((await page.locator("#q-grid tbody tr").count()) >= 3, "rows");
  });

  await step("back button restores the previous view", async () => {
    await page.goBack();
    await page.waitForTimeout(500);
    assert(await page.locator("#view-sql").isVisible(), "sql view restored");
  });

  await step("sidebar collapses; dark mode; phone width has no horizontal scroll", async () => {
    await go("#table=post&view=table");
    await page.locator("#view-table .sidebar-toggle").click();
    assert(await page.locator("#app.collapsed").count() === 1, "collapsed");
    await page.locator("#view-table .sidebar-toggle").click();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload(); await page.waitForSelector("#grid tbody tr");
    await page.setViewportSize({ width: 390, height: 800 });
    for (const v of ["#view=table", "#view=visualizer", "#view=console", "#view=sql", "#view=queries"]) {
      await go(v);
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      assert(w <= 390, `${v} scrollWidth ${w}`);
    }
  });

  console.log("page errors:", errors);
  console.log(fails || errors.length ? `${fails} FAILED` : "ALL PASSED");
  await browser.close();
  process.exit(fails || errors.length ? 1 : 0);
})();
