# Architecture

How the plugin is built, for contributors. It follows opencode-gws: one namespace, the plugin's own tools over the
vendor's REST API, plan then commit for every change.

## Parts

| Module | What it does |
| --- | --- |
| `src/index.ts`, `src/plugin.ts` | The server part: `Plugin.define` with the id `google-cloud.bigquery`, set up in opencode-github's order. |
| `src/constants.ts` | Ids, the namespace, the host range and `TESTED_HOSTS`. No imports: `scripts/check.mjs` loads it. |
| `src/options.ts` | Strict option parsing with zod; an unknown key is `OPTIONS_INVALID`. |
| `src/permissions.ts` | The default rules, inserted after each agent's base allow. |
| `src/tool-spec.ts` | Tools as specs (opencode-gws's pattern): one spec feeds the model's tool and, for a read, the scripts' method. |
| `src/tools.ts` | The namespace description and the tools' registration. |
| `src/host/script-methods.ts` | The tools RPC's plugin value and its methods, for the source contract's `tools-rpc`. |
| `src/domain/errors.ts` | The one error table. |
| `src/rpc.ts`, `src/status.ts` | The status contract, `/bigquery-status` and the status RPC. |
| `src/tui/index.tsx` | The `/bigquery` status dialog. |
| `src/skills.ts`, `src/redact.ts`, `src/host-version.ts`, `src/version.ts` | Skills, redaction, the host check and the version. |

## Setup order

Options, the host check, then each registration, kept for cleanup in reverse: the default rules; the namespace and the
tools; status; the tools RPC; the skills. Every transform is synchronous and never throws: a failure is kept, and status
shows it with its next step.
