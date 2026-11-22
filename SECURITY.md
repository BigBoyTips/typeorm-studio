# Security policy

TypeORM Studio can read and change everything its `DataSource` can reach, so
security problems in it can expose or damage real data. Thank you for
reporting them responsibly.

## Supported versions

Security fixes are released for the latest minor version only.

| Version | Supported |
|---|---|
| 1.2.x | Yes |
| < 1.2 | No |

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub:

1. Go to the [Security tab](https://github.com/BigBoyTips/typeorm-studio/security)
   of the repository.
2. Click **Report a vulnerability**.
3. Describe the problem, the affected version, and the steps to reproduce it.
   A proof of concept helps.

You should get a first response within 7 days. Once the problem is confirmed,
a fix is prepared privately and released as a new patch version. You will be
credited in the release notes unless you prefer not to be.

## What counts as a vulnerability

Studio's protections are described in the README's
[Security section](README.md#security). Reports that break one of them are in
scope, for example:

- a web page on another site that can send requests to a running Studio
  (cross-site requests, DNS rebinding);
- SQL or MongoDB injection through filters, search, sorting or table and
  column names;
- writes, raw SQL or SQL filters that still work in `--read-only` mode;
- reading files outside the `ui/` folder through the static file server;
- the AI assistant sending row data, rather than only the schema.

Out of scope:

- Anyone who can reach Studio can use it. That is how it is designed. Studio
  has no login of its own, so if you bind it to a public address
  (`--host 0.0.0.0`) or embed it without authentication, anyone who can reach
  it has full access to the database.
- SQL you run yourself in the SQL view.
- Vulnerabilities in TypeORM, database drivers or other dependencies. Report
  those to their maintainers, unless Studio uses them in an unsafe way.
