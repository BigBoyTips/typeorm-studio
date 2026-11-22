#!/usr/bin/env node
// Cross-platform test runner: `node test/run.js [sqlite|postgres|mysql|mariadb|mssql|mongodb]`.
// Sets TEST_DB without shell syntax (which Windows cmd lacks) and lists the test
// files itself, because `node --test` only expands globs from Node 21.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DBS = ["sqlite", "postgres", "mysql", "mariadb", "mssql", "mongodb"];
const db = process.argv[2] || "sqlite";
if (!DBS.includes(db)) {
  console.error(`Unknown database "${db}". Use one of: ${DBS.join(", ")}`);
  process.exit(1);
}

const files =
  db === "mongodb"
    ? [path.join(__dirname, "mongo.test.js")]
    : fs
        .readdirSync(__dirname)
        .filter((f) => f.endsWith(".test.js"))
        .sort()
        .map((f) => path.join(__dirname, f));

const env = { ...process.env };
if (db === "sqlite") delete env.TEST_DB;
else env.TEST_DB = db;

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", env });
process.exit(result.status ?? 1);
