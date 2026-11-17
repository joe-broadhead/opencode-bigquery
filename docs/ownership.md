# File ownership

Who may edit which file while the packages of the design (§15) are built in parallel. Every file in the repository
matches exactly one row; `test/unit/ownership.test.ts` fails when a file matches none or two. A package edits only its
own rows. A change to a **Day 0** file (the contract) goes through the lead, as its own pull request, so the packages
never edit each other's files or the shared contract under each other.

`*` matches within one folder; `**` matches across folders.

## Packages

| Package | Builds | Proves |
| --- | --- | --- |
| Day 0 (lead) | The repository, the contract, the registry, the plan store, the ports and their fakes. | This pull request. |
| A. Auth | The auth port: the two-level sign-in and its form, the write binding, DPoP, PKCE, the relay, ADC, `token` mode, `/bigquery-doctor`. | Design §14.1 auth and levels; L1, L2, L12, L14, L16. |
| B. Runtime | The BigQuery port over `fetch`, value conversion, paging, the fake Google server, fixture capture. | §14.1 read-path order, results; §14.3 Stop; L3, L4, L5, L8. |
| C. Reads and guards | The lexer, expansion, the side-effect, fence, cap and cost guards, the ledger, hints, policy tags, the eight read tools. | §14.1 lexer, expansion, cap, fence, policy tags, errors, cost; L6, L7, L13. |
| D. Changes | `bigquery_plan`, the five commit tools, `bigquery_cancel`, previews. | §14.1 classification and plans; §14.3 access; L15. |
| E. Files and sources | `bigquery_save`, `events_list`, `saved_read`, `saved_list`, `probe`, the conformance run. | §14.1 save and sources; conformance; L10, L11. |
| F. Status, skills, docs | `bigquery_status`, `/bigquery-status`, the TUI, both skills, the user docs. | The docs tests; §14.3 registration. |

## How the shared pieces change

- **Error codes** live in `src/domain/errors.ts` (Day 0). A package that needs a code asks the lead; each entry names
  the package that raises it (`owner`). `node scripts/docs-errors.mjs` regenerates the docs' error rows.
- **Schemas, actions, options, ports**: `src/domain/contract.ts`, `src/domain/actions.ts`, `src/options.ts`,
  `src/ports.ts` (Day 0). A package proposes a change in its pull request's description; the lead lands it first.
- **Handlers**: each package fills in its own file under `src/handlers/`; the registry picks them up with no edit.
- **Ports**: each package replaces its own unbuilt port (`src/auth/index.ts`, `src/process/bigquery.ts`,
  `src/guards/ledger.ts`); `src/wiring.ts` already wires them.
- **Dependencies**: `package.json` and `package-lock.json` are Day 0's. `google-auth-library` is already pinned for A;
  E asks for its Parquet writer.
- **CHANGELOG.md** is F's; every package adds its lines under `[Unreleased]` in its own pull request description, and F
  merges them.

## Integration checklist

When A to F have landed, before the live check:

- Re-baseline the pack budget (`MAX_PACKED_BYTES` in `test/pack/pack.test.ts`, 320 KiB at Day 0) to the measured
  packed size plus 15%, with the measurement in the comment.
- Set `WRITE_LEVEL_AVAILABLE` (`src/constants.ts`) from live check L16: false if Google returns the write marker on a
  Read sign-in.
- Confirm in live check L7 that each probe partition floor (`src/domain/probe.ts`) satisfies `requirePartitionFilter`.

## Files

| Path | Owner |
| --- | --- |
| `.github/**` | Day 0 |
| `.gitignore` | Day 0 |
| `AGENTS.md` | Day 0 |
| `CONTRIBUTING.md` | Day 0 |
| `LICENSE` | Day 0 |
| `NOTICE` | Day 0 |
| `package.json` | Day 0 |
| `package-lock.json` | Day 0 |
| `tsconfig.json` | Day 0 |
| `vitest.config.ts` | Day 0 |
| `assets/**` | Day 0 |
| `scripts/*.mjs` | Day 0 |
| `scripts/*.sh` | Day 0 |
| `scripts/*.md` | Day 0 |
| `scripts/shims/**` | Day 0 |
| `scripts/capture-fixtures/**` | B |
| `docs/architecture.md` | Day 0 |
| `docs/ownership.md` | Day 0 |
| `docs/auth.md` | A |
| `docs/configuration.md` | F |
| `docs/scripting.md` | F |
| `docs/jelly.md` | F |
| `docs/costs.md` | F |
| `docs/sql.md` | F |
| `README.md` | F |
| `SECURITY.md` | F |
| `CHANGELOG.md` | F |
| `skills/**` | F |
| `src/index.ts` | Day 0 |
| `src/plugin.ts` | Day 0 |
| `src/wiring.ts` | Day 0 |
| `src/unbuilt.ts` | Day 0 |
| `src/registry.ts` | Day 0 |
| `src/tool-spec.ts` | Day 0 |
| `src/tools.ts` | Day 0 |
| `src/permissions.ts` | Day 0 |
| `src/options.ts` | Day 0 |
| `src/ports.ts` | Day 0 |
| `src/constants.ts` | Day 0 |
| `src/version.ts` | Day 0 |
| `src/host-version.ts` | Day 0 |
| `src/redact.ts` | Day 0 |
| `src/skills.ts` | Day 0 |
| `src/domain/*.ts` | Day 0 |
| `src/host/script-methods.ts` | Day 0 |
| `src/auth/**` | A |
| `src/process/**` | B |
| `src/guards/**` | C |
| `src/handlers/reads.ts` | C |
| `src/handlers/changes.ts` | D |
| `src/changes/**` | D |
| `src/handlers/files.ts` | E |
| `src/handlers/sources.ts` | E |
| `src/files/**` | E |
| `src/sources/**` | E |
| `src/handlers/status.ts` | F |
| `src/status.ts` | F |
| `src/rpc.ts` | F |
| `src/tui/**` | F |
| `test/support/**` | Day 0 |
| `test/fake/ports.ts` | Day 0 |
| `test/fake/server.ts` | Day 0 |
| `test/fake/bigquery.ts` | B |
| `test/fixtures/statement-types.json` | Day 0 |
| `test/fixtures/google/**` | B |
| `test/unit/*.test.ts` | Day 0 |
| `test/unit/auth/**` | A |
| `test/unit/process/**` | B |
| `test/unit/guards/**` | C |
| `test/unit/reads/**` | C |
| `test/unit/changes/**` | D |
| `test/unit/files/**` | E |
| `test/unit/sources/**` | E |
| `test/unit/status/**` | F |
| `test/conformance/declaration.test.ts` | Day 0 |
| `test/conformance/jelly-master.test.ts` | Day 0 |
| `test/conformance/run/**` | E |
| `test/host/harness.ts` | Day 0 |
| `test/host/isolate.ts` | Day 0 |
| `test/host/route-fetch.ts` | Day 0 |
| `test/host/scratch.ts` | Day 0 |
| `test/host/plugin.test.ts` | Day 0 |
| `test/host/auth.test.ts` | A |
| `test/host/runtime.test.ts` | B |
| `test/host/reads.test.ts` | C |
| `test/host/changes.test.ts` | D |
| `test/host/sources.test.ts` | E |
| `test/host/status.test.ts` | F |
| `test/pack/**` | Day 0 |
