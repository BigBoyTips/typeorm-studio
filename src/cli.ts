#!/usr/bin/env node
import "reflect-metadata";
import * as path from "path";
import { DataSource } from "typeorm";
import { startStudio } from "./server";

const HELP = `typeorm-studio — browse and edit your TypeORM data in the browser

Usage:
  typeorm-studio -d <path/to/data-source.(ts|js)> [options]

Options:
  -d, --dataSource <path>  File exporting a DataSource (default export or any named export)
  -p, --port <n>           Port (default 5555)
      --host <host>        Host to bind (default 127.0.0.1)
      --read-only          Disable edits and the SQL console
  -h, --help               Show help
`;

function parseArgs(argv: string[]) {
  const out: { dataSource?: string; port: number; host: string; readOnly: boolean } = {
    port: 5555,
    host: "127.0.0.1",
    readOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      console.log(HELP);
      process.exit(0);
    } else if (a === "-d" || a === "--dataSource" || a === "--data-source") out.dataSource = argv[++i];
    else if (a === "-p" || a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--read-only") out.readOnly = true;
    else {
      console.error(`Unknown argument ${a}\n\n${HELP}`);
      process.exit(1);
    }
  }
  return out;
}

/** Same lookup rule as the TypeORM CLI: any exported DataSource instance. */
async function loadDataSource(file: string): Promise<DataSource> {
  const full = path.resolve(process.cwd(), file);
  if (/\.(c|m)?ts$/.test(full)) {
    // Prefer ts-node: it honours emitDecoratorMetadata, which TypeORM relies on to infer column types.
    try {
      require(require.resolve("ts-node/register", { paths: [process.cwd()] }));
    } catch {
      try {
        require(require.resolve("tsx/cjs", { paths: [process.cwd(), __dirname] }));
      } catch {
        throw new Error("Loading a .ts data source needs `tsx` or `ts-node` installed in your project.");
      }
    }
  }
  let mod: Record<string, unknown>;
  try {
    mod = require(full);
  } catch (e) {
    if ((e as { code?: string }).code !== "ERR_REQUIRE_ESM") throw e;
    mod = await import(require("url").pathToFileURL(full).href);
  }
  const candidates = [mod.default, ...Object.values(mod)];
  const ds = candidates.find((v) => v instanceof DataSource || (v && (v as DataSource).constructor?.name === "DataSource"));
  if (!ds) throw new Error(`${file} does not export a DataSource`);
  return ds as DataSource;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dataSource) {
    console.error(HELP);
    process.exit(1);
  }
  const ds = await loadDataSource(args.dataSource);
  if (!ds.isInitialized) await ds.initialize();
  const server = await startStudio(ds, { port: args.port, host: args.host, readOnly: args.readOnly });
  if (!["127.0.0.1", "localhost", "::1"].includes(args.host)) {
    console.warn(
      `Warning: Studio is listening on ${args.host}. Anyone who can reach this address can read and change your database${args.readOnly ? "" : " and run SQL"}. Put authentication in front of it or use --read-only.`,
    );
  }
  console.log(
    `TypeORM Studio is up on http://${args.host}:${args.port}  (${ds.entityMetadatas.length} entities, ${ds.options.type}${args.readOnly ? ", read-only" : ""})`,
  );
  const shutdown = async () => {
    server.close();
    await ds.destroy().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
