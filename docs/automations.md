# Automations

The plugin declares one events source, `bigquery.jobs`: the jobs this account finished, oldest first, read with a
cursor. `plugin-kit docs` writes the table below from `capabilities.sources`; edit the manifest, never the table.

<!-- generated:automations -->
| Source | Method | Provider floor | Suggested | Signals |
|---|---|---|---|---|
| `bigquery.jobs` | `tools.bigquery.events_list` | — | 5 min | `bus` |
<!-- /generated:automations -->

## A timer that reads new jobs

An OpenCode automation runs a Code Mode call on a schedule. Keep the cursor in the automation's state, and pass it back
on the next run: the plugin stores nothing between reads.

```js
export default {
  name: "bigquery-jobs",
  every: "5 minutes",
  async run({ state, call, saveState }) {
    // With no cursor the source starts 24 hours back; later runs replay from the saved cursor.
    const page = await call("bigquery", "events_list", {
      account: "work",
      ...(state.cursor === undefined ? {} : { cursor: state.cursor }),
    })
    for (const event of page.events) {
      // event.external_id is the job; event.title says its type and what it billed.
      await report(event)
    }
    // A failed read holds the cursor back: replay the same window next time.
    if ((page.failed ?? []).length === 0) await saveState({ cursor: page.cursor })
    return { read: page.events.length, more: page.more }
  },
}
```

The recipe's rules:

- **Keep the cursor in state**, never in a file of the plugin's: `read` stores nothing.
- **Do not advance past `failed[]`**: an entry there means a job could not be read this time.
- **`refused[]` is final**: a job whose title held a credential is never delivered, and the cursor may advance past it.
- **`gap` is a resync, not data**: render it; do not invent the missing jobs. A six-month-old cursor is `CURSOR_EXPIRED`
  or a `gap` with reason `expired`.
- **The bus is optional**: a `rpc.bigquery.changed` event says a source moved; it carries no content, so re-read
  `bigquery.jobs` through RPC.

## Scope

`events_list` reads the account's billing project unless the confirmed scope names `projects`:

```json
{ "account": "work", "scope": { "projects": ["work-project-1234", "shared-project-5678"] } }
```

Only jobs this account started are listed; `jobs.list` is free and keeps six months of history.
