# Contributing to TypeORM Studio

## Setup

```bash
pnpm install     # or: npm install
npm run build    # compiles src/ to dist/
```

The tests and the example commands run the compiled code in `dist/`, so
rebuild after changing anything in `src/`.

## Project layout

| Path | Contents |
|---|---|
| `src/` | Server, CLI and database adapters (TypeScript, compiled to `dist/`) |
| `ui/` | The browser app. Plain JavaScript and CSS, no build step |
| `ui-src/` | Source for the bundled CodeMirror editor in `ui/vendor/` |
| `example/` | Example entities, data sources and seed scripts |
| `test/` | Backend tests (`node --test`) and a browser test (`test/e2e/`) |
| `docs/` | Screenshots and the release guide |

## Running the example

```bash
npm run seed             # creates example/dev.sqlite
npm run studio:example   # opens Studio on http://127.0.0.1:5555
```

To use another database, set `DATABASE_URL` (`postgres://…`, `mysql://…`,
`mariadb://…`) before both commands.

For MongoDB, set `MONGO_URL` (default
`mongodb://127.0.0.1:27017/typeorm_studio_example`) and run:

```bash
npm run seed:mongo
npm run studio:mongo
```

## Tests

```bash
npm test
```

This runs the backend suite on an in-memory SQLite database. The same suite
runs against a live server when `TEST_DB` is set:

| Script | Database | Connection variable (default) |
|---|---|---|
| `npm run test:postgres` | PostgreSQL | `PG_URL` (`postgres://postgres@127.0.0.1:5433/studio`) |
| `npm run test:mysql` | MySQL | `MYSQL_URL` (`mysql://studio:studio@127.0.0.1:3307/studio`) |
| `npm run test:mariadb` | MariaDB | `MARIADB_URL`, else `MYSQL_URL` |
| `npm run test:mssql` | SQL Server | `MSSQL_URL` (`mssql://sa:Studio_Pass1@127.0.0.1:14330/studio`) |
| `npm run test:mongo` | MongoDB | `MONGO_URL` (`mongodb://127.0.0.1:27018/studio_test`) |

**On Windows**, these scripts only work from Git Bash or WSL, because they set
`TEST_DB` with Unix shell syntax. In PowerShell, set it yourself:

```powershell
$env:TEST_DB = "postgres"; node --test test/*.test.js
```

### Browser test

The browser test drives the real UI. It needs Playwright (not a dependency of
this package) and a running example Studio:

```bash
npm run seed
npm run studio:example
node test/e2e/ui.e2e.js   # in a second terminal; BASE defaults to http://127.0.0.1:5555/
```

## The editor bundle

The UI has no build step except the CodeMirror editor, which is bundled into
`ui/vendor/codemirror.js`. After changing `ui-src/` or upgrading a
`@codemirror/*` or `@lezer/*` package, rebuild it:

```bash
npm run build:ui
```

This also regenerates the third-party licences in `ui/vendor/LICENSES.txt`.

## Releasing

See [docs/PUBLISHING.md](docs/PUBLISHING.md).
