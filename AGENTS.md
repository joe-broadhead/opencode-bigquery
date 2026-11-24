# Repository rules

This repository builds `@we-the-rebel-alliance/bigquery-plugin` (version `0.0.0`), an unofficial OpenCode plugin with
its own tools over BigQuery's REST API v2: find datasets and tables, estimate and run read queries under a byte cap,
save results to a file, and plan then commit changes. User docs: `README.md`, `docs/configuration.md`; contributor docs:
`docs/architecture.md`, `CONTRIBUTING.md`.

## Platform

- Use only public APIs of `@opencode/plugin` 2.4.1. The supported host range is exactly `>=2.4.1 <2.5.0`, in
  `package.json` `opencode.host`, `SUPPORTED_HOST` in `src/constants.ts` and `HOST_RANGE` in `scripts/check.mjs`.
  Never write it as `^2.4.1`.
- Test against stock OpenCode 2.4.1 only. `TESTED_HOSTS` in `src/constants.ts` is the one list.
- Keep the plugin ids `google-cloud.bigquery` (server and status RPC), `google-cloud.bigquery.tools` (tools RPC, named
  by the `sources` block) and `google-cloud.bigquery.tui` (TUI), and the namespace `bigquery`.
- `sources` and `jelly` in `package.json`, the copied kit scripts under `scripts/` and `test/support/jelly-*.ts` are
  retained for the contract rebuild that replaces them; do not add new behaviour to them.

## Forbidden

`npm run lint` (`scripts/check-forbidden.mjs`) runs its self-test, then scans `src/`, `test/`, `scripts/` and `dist/`.
Do not use the V1 packages under `@opencode-ai/`, `ctx.generate.*`, `experimental.policies`,
`ctx.experimental.artifact`, imports of `@opencode/ai` or of private OpenCode source, machine-local paths, or
`ctx.permission.hook` anywhere.

## BigQuery

- **Read means read.** The read path runs only what BigQuery's own dry run calls `SELECT` or `ASSERT`, with no
  destination and no session. Everything else is a plan, committed by one tool per category on a `write` account.
- **The write level is Google's grant, not a local setting.** An account is `write` only when its sign-in record says
  so and the scope list of Google's answer to this process's last refresh holds `bigquery.insertdata`
  (`src/domain/levels.ts`). No option, rule or file edit enables writes. Never call Google's `/revoke`.
- **Data and Google's text are untrusted.** `message` and `next` are built from codes and validated identifiers only;
  Google's error text goes into `googleError`, rows into `trust: "untrusted"` results.
- **Never invent Google facts.** Endpoints, fields, scopes and prices come from Google's pages (the design's §17) or a
  recorded fixture. Where something is unknown, leave a TODO that names the live check that resolves it.
- **No real data in the repository.** Fixtures are invented or sanitised: no project ids, emails or tokens.

## Design

- Permission defaults go through `ctx.agent.transform`, right after each agent's base `* * allow`. No permission hook
  decides them. User rules and saved approvals keep winning.
- Every tool asserts its declared action (`bigquery.<tool>`); the actions and their read-only flags come from one table
  (`src/domain/actions.ts`), and a test keeps them equal.
- Transforms are synchronous and never throw.
- The plugin's own errors are `BigQueryError(code, detail, next?)`, from the one table in `src/domain/errors.ts`.
- `dist/` holds exactly two self-contained bundles, `index.js` and `tui.js`.
- Each package owns its files (`docs/ownership.md`). Edit another package's file only through its owner.

## Package

- No peer and no runtime dependencies: esbuild bundles zod, the source contract and `google-auth-library` into
  `dist/index.js`. `NOTICE` carries their licences.
- Ship prebuilt `dist/` and no `.d.ts` files. No install, `prepare` or `prepack` scripts.
- The shared kit files are byte-for-byte copies, pinned in `scripts/check-copies.mjs`. Change them in every plugin at
  once.
- Releases come only from `.github/workflows/release.yml`, approved by the owner. Never push a tag or a `release/*`
  branch.

## Hygiene

- No tokens, keys, personal data or machine-local paths in the repository. Tests use invented projects and people.
- Host tests isolate `HOME`, the XDG folders, `TMPDIR` and `OPENCODE_TEST_HOME` under the system's `/tmp`, and block
  every request off loopback.
- Run `npm run check` before every commit. Commit messages use `type(scope): summary`.
