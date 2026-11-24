# Contributing

## Setup

- Node.js 22.12 or later, with npm. CI uses Node.js 24.
- Bun 1.4 (CI uses 1.4.4). The conformance, host and pack tests run with `bun test`.
- macOS or Linux.

```sh
git clone https://github.com/we-the-rebel-alliance/bigquery-plugin.git
cd bigquery-plugin
npm ci --ignore-scripts
npm run check
```

No dependency needs install scripts, and OpenCode installs plugins without them, so always pass `--ignore-scripts`.

### Run your checkout in OpenCode

Build it, then add the clone's path to `plugins` in your OpenCode config instead of the release install:

```sh
npm run build
```

```json
{ "plugins": [{ "package": "/path/to/bigquery-plugin" }] }
```

## `npm run check`

One command, `scripts/check.mjs`, runs every stage in order and stops at the first failure. `node scripts/check.mjs
<stage>...` runs only the named stages.

| Stage | What it does |
| --- | --- |
| `typecheck` | `tsc` over `src/` and the tests. |
| `unit` | Vitest over `test/unit/`. |
| `conformance` | The source contract's declaration checks over the `sources` block, under Bun. |
| `kit` | The release kit's own tests. |
| `build` | esbuild bundles `dist/index.js` and `dist/tui.js`, and checks `NOTICE`. |
| `icons` | The family icon contract. |
| `host` | The built plugin in an embedded OpenCode 2.4.1 host, with every request off loopback blocked. |
| `pack` | Packs, installs with scripts disabled and imports both entries. |
| `forbidden` | The forbidden APIs and private names. |
| `copies` | The shared kit files against their pinned hashes. |
| `whitelist` | `package.json` and `dist/` against the approved package shape. |
| `actionlint` | The workflows, when `actionlint` is on PATH (CI installs it). |

## Releases

Versions follow semantic versioning on the plugin's contract: its options, the tool names and actions, the
`/bigquery-status` command, the status RPC, the tools RPC and its `sources` block, the skill names and the default
rules.

Each release is the GitHub tag `v<version>`, made only by `.github/workflows/release.yml` after the owner approves the
`release` environment. While changes land, their notes go under `## [Unreleased]` in `CHANGELOG.md`; a release-prep
commit runs `node scripts/changelog.mjs release`. `package.json` stays `"private": true` and in canonical form.

A pull request's CI runs the one `ci` job on Node 24 with `ubuntu-24.04`. The release workflow runs its own checks on
the release commit before the owner approves it.
