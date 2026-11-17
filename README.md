# BigQuery for OpenCode

Connects OpenCode to [Google BigQuery](https://cloud.google.com/bigquery) through BigQuery's REST API, so your agents
can find datasets and tables, estimate a query before running it, run reads under a byte cap, save results to a file
for charts, and plan then commit changes.

Unofficial; not affiliated with Google. BigQuery and Google Cloud are trademarks of Google LLC. The icon is the
family's own tile, not Google's mark.

> **Not yet released.** This is v0.0.1 before its first release. The repository holds the plugin's skeleton and its
> contract: the tools are declared and answer that they are not built yet. Nothing calls Google yet.

## Requirements

- OpenCode `>=2.2.3 <2.4.0`, tested on 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7 and 2.3.0. A later 2.2 or 2.3 release loads
  too, and the status marks it untested. Outside `>=2.2.3 <2.4.0` the plugin does not load, unless you set
  [`allowUntestedHost`](docs/configuration.md#options).
- macOS or Linux.
- A Google Cloud project with the BigQuery API on, to bill queries to. For read-only use, your admin grants you
  BigQuery Job User on that project and BigQuery Data Viewer on the datasets you read, and nothing more.

## Install

```sh
opencode plugin add github:joe-broadhead/opencode-bigquery#v0.0.1
```

Run `opencode reload`, or restart OpenCode. Then run `/bigquery-status` in a session.

Or add the plugin to `opencode.json` instead, with the same spec:

```json
{ "plugins": [{ "package": "github:joe-broadhead/opencode-bigquery#v0.0.1" }] }
```

The install takes the GitHub release tag. Its commit carries the built `dist/`, so the install runs no build. A Git
install does not update by itself: to move to a newer release, remove the old entry with `opencode plugin remove`, then
add the new tag.

## Permissions

The `access` option (`all`, the default; `ask-changes`; `read-only`) generates default rules for every agent with a
base allow. See [Permissions](docs/configuration.md#permissions).

## Security

See [SECURITY.md](SECURITY.md).

## Troubleshooting

Every code the plugin raises, with its next step. `/bigquery-status` shows the plugin's state and the next step.

<!-- errors:start -->
| Code | What happened | Next step |
| --- | --- | --- |
| `HOST_UNTESTED` | The OpenCode version is outside the supported range (>=2.2.3 <2.4.0). | Update OpenCode or the plugin, or set the plugin option allowUntestedHost: true. |
| `INPUT_INVALID` | The tool's input does not fit its schema; nothing was sent to Google. | Check the input against the tool's schema, then call it again. |
| `OPTIONS_INVALID` | The plugin options are not valid: an unknown key, a wrong type, or a value out of range. | Fix the plugin options in opencode.json; the message names the option. |
| `RULES_NOT_ADDED` | The default permission rules could not be added to the agents, so BigQuery tools may run without asking. | Restart OpenCode. |
| `SKILLS_INVALID` | A skill file that ships with the plugin is missing or unreadable. | Reinstall the plugin. |
| `STATUS_UNAVAILABLE` | The status could not be computed. | Try again in a few seconds; if it persists, restart OpenCode. |
| `TOOLS_NOT_REGISTERED` | The plugin's tools could not be registered with OpenCode. | Restart OpenCode. |
<!-- errors:end -->

## Uninstall

```sh
opencode plugin remove github:joe-broadhead/opencode-bigquery#v0.0.1
```

## License

MIT. The bundled third-party code and its licences are listed in [NOTICE](NOTICE).
