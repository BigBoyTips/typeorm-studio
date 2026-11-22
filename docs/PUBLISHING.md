# Publishing typeorm-studio to npm

How to release a new version of `typeorm-studio` to the npm registry.

- [What gets published](#what-gets-published)
- [One-time setup](#one-time-setup)
- [Releasing a version](#releasing-a-version)
- [Checking the release](#checking-the-release)
- [Publishing under a scope](#publishing-under-a-scope)
- [Fixing a bad release](#fixing-a-bad-release)
- [Troubleshooting](#troubleshooting)

---

## What gets published

The `files` field in `package.json` limits the package to:

| Path | Contents |
|---|---|
| `dist/` | Compiled JavaScript and type declarations, built from `src/` by `npm run build` |
| `ui/` | The browser app (`index.html`, `app.js`, `styles.css`) and the bundled CodeMirror editor in `ui/vendor/` |
| `README.md`, `LICENSE`, `package.json` | Always included by npm |

`src/`, `test/`, `example/`, `docs/` and `ui-src/` are **not** published.

> **`dist/` is what users run.** npm publishes whatever is in `dist/` at that moment. If you edit `src/` and forget to build, the old code ships. The `prepublishOnly` script prevents this (see [step 4](#4-build-and-test-before-every-publish)).

The package exposes:

- the library entry point `typeorm-studio` (`dist/index.js`, types in `dist/index.d.ts`). The `exports` map allows only this entry point and `typeorm-studio/package.json`. Anything else a user should import must be re-exported from `src/index.ts`.
- the `typeorm-studio` command, from `dist/cli.js`

Peer dependencies, which users install themselves:

- `typeorm` (`^0.3.0`), required
- `@anthropic-ai/sdk` (`^1.4.0`), optional: only needed for the AI assistant. It is also a dev dependency so the package builds.

> **Keep optional packages out of the public types.** A type in `dist/*.d.ts` that references `@anthropic-ai/sdk` breaks TypeScript users who haven't installed it. Keep SDK types inside function bodies or non-exported functions in `src/ai.ts`, and check after building that `dist/ai.d.ts` doesn't import the SDK.

---

## One-time setup

### 1. Create an npm account and log in

Create an account at [npmjs.com](https://www.npmjs.com/signup) and turn on two-factor authentication. Then log in from the machine you will publish from:

```sh
npm login
npm whoami    # should print your npm username
```

### 2. Check the package name

```sh
npm view typeorm-studio
```

A `404 Not Found` means the name is free. If someone else owns it, either publish under a scope (see [Publishing under a scope](#publishing-under-a-scope)) or choose another name.

### 3. Complete package.json

`repository`, `homepage` and `bugs` point to
[github.com/BigBoyTips/typeorm-studio](https://github.com/BigBoyTips/typeorm-studio).
If the repository moves, update all three. `author` is set to
`BigBoyTips (https://github.com/BigBoyTips)`; change it to a different name or
add an email (`"Your Name <you@example.com> (https://…)"`) if you prefer.

> **Screenshots need `repository`.** The README shows images from `docs/` by relative path. `docs/` is not in the package, so npmjs.com can only display them by resolving the paths against the GitHub repository in the `repository` field. Without it, the images are broken on the npm page.

### 4. Build and test before every publish

`package.json` has a `prepublishOnly` script, so `npm publish` always builds and tests first and stops if either fails. Keep it:

```json
"prepublishOnly": "npm run build && npm test"
```

The same checks run on GitHub for every push to `main` and every pull request (`.github/workflows/ci.yml`, on Node 20, 22 and 24). It installs with `pnpm install --frozen-lockfile`, so commit `pnpm-lock.yaml` whenever dependencies change.

---

## Releasing a version

### 1. Decide the version number

Use [semantic versioning](https://semver.org/):

| Change | Command | Example |
|---|---|---|
| Bug fixes only | `npm version patch` | 1.2.0 → 1.2.1 |
| New features, nothing broken | `npm version minor` | 1.2.0 → 1.3.0 |
| Breaking change (removed option, changed API, dropped Node or TypeORM version) | `npm version major` | 1.2.0 → 2.0.0 |

### 2. Rebuild the editor bundle (only if needed)

`ui/vendor/codemirror.js` and `ui/vendor/LICENSES.txt` are generated files that are committed to the repo. Rebuild them only if you changed `ui-src/` or upgraded a `@codemirror/*` or `@lezer/*` package:

```sh
npm run build:ui
```

### 3. Build and run the tests

```sh
npm install
npm run typecheck
npm run build
npm test
```

`npm test` uses SQLite. The tests for other databases are skipped unless you point them at a running server. For a release that touches database-specific code, run the matching suite too:

```sh
npm run test:postgres   # also: test:mysql, test:mariadb, test:mssql, test:mongo
```

These scripts set the variable `TEST_DB=...` with Unix shell syntax. On Windows, run them from Git Bash or WSL.

### 4. Try the packed package locally

Build the exact tarball that would be uploaded, and install it in a separate project:

```sh
npm pack                  # creates typeorm-studio-<version>.tgz
npm pack --dry-run        # or just list the files without creating it
```

In a separate TypeORM project:

```sh
npm install /path/to/typeorm-studio-<version>.tgz
npx typeorm-studio -d src/data-source.ts
```

Check that the UI loads, tables list, and rows can be filtered and edited. Delete the `.tgz` afterwards.

### 5. Update the changelog and bump the version

In `CHANGELOG.md`, rename `## [Unreleased]` to the new version and add the date, for example `## [1.2.1] - 2026-12-01`. Then start a new empty `## [Unreleased]` section above it.

For the first release, `package.json` already says `1.2.0`, so skip `npm version`. Just add the date to the existing `## [1.2.0]` heading.

```sh
npm version patch     # or minor / major
```

This updates `version` in `package.json`. In a git repository it also creates a commit and a tag such as `v1.2.1`. Push both:

```sh
git push && git push --tags
```

### 6. Publish

```sh
npm publish
```

With two-factor authentication on, npm asks for a one-time code. With the `prepublishOnly` script in place, the build and tests run first.

To publish a pre-release without making it the default install, use a dist-tag:

```sh
npm version prerelease --preid beta   # 1.3.0-beta.0
npm publish --tag beta                # installed with: npm install typeorm-studio@beta
```

---

## Checking the release

```sh
npm view typeorm-studio version          # the latest published version
npm view typeorm-studio dist-tags        # which version each tag points to
```

Then install it from the registry in a clean project and run it once:

```sh
npm install -D typeorm-studio
npx typeorm-studio -d src/data-source.ts
```

The package page is at `https://www.npmjs.com/package/typeorm-studio`.

---

## Publishing under a scope

If the unscoped name is taken, or you want the package tied to your account or organisation, rename it:

```jsonc
"name": "@your-scope/typeorm-studio"
```

Scoped packages are private by default, which needs a paid npm plan. To publish publicly:

```sh
npm publish --access public
```

You only need `--access public` on the first publish. Update the install commands in `README.md` to the new name.

---

## Fixing a bad release

You **cannot** reuse a version number, even after unpublishing it. Fix forward:

1. Fix the problem and publish a new patch version.
2. Mark the broken version so installers see a warning:

   ```sh
   npm deprecate typeorm-studio@1.2.1 "Broken build, use 1.2.2"
   ```

`npm unpublish typeorm-studio@<version>` is allowed only within 72 hours of publishing, and only if no other public package depends on it. Prefer deprecating.

If a pre-release was accidentally published as `latest`, point the tag back:

```sh
npm dist-tag add typeorm-studio@1.2.0 latest
```

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `ENEEDAUTH` / `need auth` | Not logged in | `npm login` |
| `E403 ... You do not have permission to publish` | The name belongs to someone else, or is too similar to an existing package | Use a scope or another name |
| `E403 ... cannot publish over the previously published versions` | That version already exists | `npm version patch` and publish again |
| `EOTP` / one-time password required | Two-factor authentication is on | Enter the code from your authenticator, or pass `--otp=123456` |
| `E402 Payment Required` | Publishing a scoped package without `--access public` | `npm publish --access public` |
| Users report old behaviour after a release | `dist/` was stale when published | Check the `prepublishOnly` script is still in `package.json`, then release a new patch |
| TypeScript users see `Cannot find module '@anthropic-ai/sdk'` | A public type references the optional SDK | Keep SDK types out of exported signatures (see [What gets published](#what-gets-published)) |
| `ERR_PACKAGE_PATH_NOT_EXPORTED` | A user imports a file that isn't in the `exports` map | Re-export what they need from `src/index.ts` |
| `typeorm-studio: command not found` after install | `dist/cli.js` missing from the package | Run `npm run build`, then check `npm pack --dry-run` lists `dist/cli.js` |

---

## Release checklist

- [ ] `npm whoami` shows the right account
- [ ] `ui/vendor/` rebuilt if `ui-src/` or CodeMirror packages changed
- [ ] `npm run typecheck`, `npm run build` and `npm test` pass
- [ ] Database-specific suites run, if the release touches that code
- [ ] CI is green on GitHub
- [ ] `npm pack` tarball installed and tried in a real project
- [ ] `CHANGELOG.md` heading has the version and date
- [ ] Version bumped with `npm version` (not for the first 1.2.0 release)
- [ ] `npm publish` succeeded
- [ ] `npm view typeorm-studio version` shows the new version
- [ ] Git commit and tag pushed
