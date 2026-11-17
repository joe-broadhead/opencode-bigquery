# Scripting

Unofficial plugin. Not affiliated with Google.

A script can call BigQuery's read tools with no model: a cron job, a shell script, or any program that can reach the
OpenCode server. It uses the tools RPC, `google-cloud.bigquery.tools`, through `opencode api` or an OpenCode client:

```sh
opencode api post /api/rpc/google-cloud.bigquery.tools/<method> -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"<id>","input":{…}}}'
```

The transport is the source contract's (`@we-the-rebel-alliance/source-contract`, tag v0.2.0), shared by the family.
Only the read tools are methods; a change runs only from the model's tool, after its own asks.

| Method | Class | The tool |
| --- | --- | --- |
| `describe` | none | Lists every method with its class, its permission action and whether it can run now. |

## A script runs as a session

Every call names a session, and the session must name an agent. Create it for the script once, with the project as its
`location`, and keep its id:

```sh
opencode api post /api/session -d '{"title":"bigquery digest","agent":"build","location":{"directory":"/path/to/project"}}'
```

Only a prior explicit `allow` for a method's action runs: an `ask` is refused, because nobody can answer it.

## Errors

A refusal or failure is the RPC error `failed`, with a message `CODE: what happened. Next step: what to do.` and
`data: { code, next }`.

| Code | When |
| --- | --- |
| `PERMISSION_DENIED` | The rules ask or deny. An `ask` is refused before dispatch. |
| `SESSION_UNKNOWN` | OpenCode says the session does not exist in this location. |
| `SESSION_AGENT_REQUIRED` | The session names no agent, or an agent that does not exist. |
| `RESOURCE_UNRESOLVED` | The method could not tell which account and operation the call acts on. |
| `CANCELLED` | The request was cancelled. |

A method also reports the plugin's own errors, listed in [Errors](configuration.md#errors).

## Status

The status RPC, `google-cloud.bigquery`, returns what `/bigquery-status` shows, and makes no call to Google:

```sh
opencode api post /api/rpc/google-cloud.bigquery/status -H "x-opencode-directory:$PWD" -d '{"input":{}}'
```

The family's shared fields are `version`, `host`, `unguardedAgents` and `nextStep`. BigQuery's own fields beside them:
`access`, `tools` (`registered`, `notBuilt`), `permissionsBlock`, `shadowedSkills`, `problems` and `hostWarning`.
