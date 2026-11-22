# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/).

## [1.2.1]

### Removed

- The AI assistant ("Ask AI" in the filter menu and the SQL view), the `ai`
  procedure, the `ai` handler option and the `askAi` export. Studio no longer
  has `@anthropic-ai/sdk` as an optional peer dependency.

### Fixed

- Saving an edit to a row that was deleted in the meantime now reports "Row no
  longer exists" on every TypeORM 0.3 release. Early 0.3 versions failed with
  `repo.exist is not a function`.

## [1.2.0] - 2026-11-22

### Changed

- Requires Node.js 20 or later.
- `@anthropic-ai/sdk` is no longer installed automatically. It is now an
  optional peer dependency: install it yourself to use the AI assistant.
- The package now has an `exports` map. Import from `typeorm-studio`;
  deep imports such as `typeorm-studio/dist/adapter` are no longer allowed.
- The UI's files are served gzip-compressed with ETags, so reloads re-use the
  browser's copy instead of downloading about 590 KB again.
- Query Insights does its SQL parsing once per distinct statement instead of on
  every query, which lowers the overhead on your app's own queries.
- Column type detection, entity lookups and the table metadata sent to the UI
  are computed once and reused.

### Fixed

- The MongoDB example's `objectId` column no longer fails the TypeScript check.
