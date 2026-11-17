# Configuration

Unofficial plugin. Not affiliated with Google.

The plugin works without options. Set them on its entry in `opencode.json`:

```json
{
  "plugins": [
    { "package": "github:joe-broadhead/opencode-bigquery#v0.0.1", "options": { "access": "ask-changes" } }
  ]
}
```

Options are strict: an option the plugin does not know stops it from loading with `OPTIONS_INVALID`, which names the
option, so a typo cannot leave the plugin more open than you meant.

## Options

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `access` | `"all"`, `"ask-changes"` or `"read-only"` | `"all"` | What the default rules allow. See [Permissions](#permissions). |
| `allowUntestedHost` | boolean | `false` | Load on an OpenCode release outside `>=2.2.3 <2.4.0`, with a warning in status. |

## Permissions

The `access` option generates a block of default rules. The block goes right after each agent's base `* * allow`
rule, starting with `bigquery.*` at the change effect, so an action the plugin does not declare is treated like a
change. The change effect is `allow` at `all`, `ask` at `ask-changes` and `deny` at `read-only`. The last matching rule
wins, so your own rules after the block, an agent's stricter rules and saved approvals still win.

An agent defined only in your config gets no block, because OpenCode creates it after plugins run. `/bigquery-status`
names it and shows the block: put the block first in that agent's own `permissions`.

## Errors

Every code the plugin raises. Each message reads `CODE: What happened. Next step: What to do.`

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
