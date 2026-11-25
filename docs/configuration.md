# Configuration

The plugin's options, their types and their defaults, generated from `capabilities.options`. `plugin-kit docs` writes
the table; edit the schema in `package.json`, never the table.

<!-- generated:configuration -->
| Option | Type | Default | Description |
|---|---|---|---|
| `access` | `all` \| `ask-changes` \| `read-only` | `"all"` | How much the plugin's methods may do: everything, reads with each change asking, or reads only. |
| `accounts` | object | — | One profile per account alias, such as work and personal. Each alias signs in to its own integration. |
| `allowUntestedHost` | boolean | `false` | Start outside the tested OpenCode range. |
| `oauthClient` | object | — | A Desktop OAuth client for every account, when a profile names none. |
| `redirectUri` | string | — | The OAuth redirect URI, when the plugin cannot open its own loopback listener. |
| `callbackPort` | integer | — | The loopback port the OAuth redirect listens on; required with redirectUri. |
| `maxBytesBilled` | integer \| string | `"10GiB"` | The byte cap on a query unless the call passes maxBytes: a whole number or a size such as 10GiB. |
| `maxBytesCeiling` | integer \| string | `"100GiB"` | The most a call may raise the byte cap to, as a whole number or a size such as 100GiB. |
| `budget` | object | — | A spend budget counted from what Google billed: daily or per session bytes, and whether to refuse or warn. |
| `onDemandUsdPerTiB` | number | `6.25` | The on-demand price per TiB scanned, for the cost a call reports; Google's list price is 6.25. |
| `maxRows` | integer | `50` | Rows a query returns to the model unless the call asks for another count. |
| `maxInlineBytes` | integer \| string | `"32KiB"` | The most bytes of rows one answer carries to the model; more rows are saved to a file instead. |
| `maxSaveRows` | integer | `1000000` | The most rows save writes to a local file. |
| `maxSaveBytes` | integer \| string | `"256MiB"` | The most bytes save writes to a local file. |
| `resultsDir` | string | `".bigquery/results"` | The folder save writes under, relative to the project. |
| `allowedRoots` | array | `[]` | Extra folders save may write into, besides the project. |
| `jobTimeoutSeconds` | integer | `600` | The time limit on a query or change job. |
| `uncappedTimeoutSeconds` | integer | `120` | The shorter time limit on a read the byte cap cannot bound. |
| `maxConcurrentJobs` | integer | `4` | Jobs this plugin runs at once for one account. |
| `scripts` | boolean | `true` | Allow a script (several statements) to be planned and committed. |
| `uncappedReads` | `ask` \| `refuse` | `"ask"` | ask lets a read the byte cap cannot bound run from a plan; refuse always refuses it. |
| `policyTagged` | `withhold` \| `allow` | `"withhold"` | Whether rows from policy-tagged columns are withheld from the model or allowed. |
| `savedQueries` | object | `{}` | The saved queries the bigquery.saved source may run, by name: their SQL, project, location, cap and whether a cache hit is allowed. |
| `admin` | object | `{"enabled":true,"requireReason":true}` | Admin statements (reservations, capacity, connections, IAM): whether they may be planned, and whether a reason is required. |
<!-- /generated:configuration -->

## Examples

### Sign in to two accounts

```json
{
  "options": {
    "accounts": {
      "work": { "billingProject": "work-project-1234", "location": "EU" },
      "personal": { "billingProject": "home-project-5678" }
    }
  }
}
```

Run `/connect` once per alias; the integrations are `bigquery-work` and `bigquery-personal`.

### Ask before every change

```json
{ "options": { "access": "ask-changes", "accounts": { "work": { "billingProject": "work-project-1234" } } } }
```

A read the cap cannot bound asks too (`run_query`'s effect is `ask`): it runs under `all`, and asks under
`ask-changes` and `read-only`.

### A tighter cap and a daily budget

```json
{
  "options": {
    "maxBytesBilled": "5GiB",
    "maxBytesCeiling": "50GiB",
    "budget": { "daily": "200GiB", "session": "50GiB", "action": "refuse" },
    "accounts": { "work": { "billingProject": "work-project-1234" } }
  }
}
```

`budget` counts what Google actually billed, from the ledger at
`$XDG_STATE_HOME/bigquery-plugin/spend.jsonl`; a query that would exceed it is `BUDGET_EXCEEDED`.

### Keep one dataset off this machine

```json
{
  "options": {
    "accounts": {
      "work": {
        "billingProject": "work-project-1234",
        "datasets": { "allow": ["work-project-1234.analytics", "work-project-1234.raw"] },
        "inline": { "deny": ["work-project-1234.hr"] }
      }
    }
  }
}
```

`datasets.allow` is a fence: every object a read or a change touches must be inside it. `datasets.deny` wins over allow.
`inline.deny` keeps a dataset's rows out of the model: a read over it answers save-only, with `next` naming `save`.

### A saved query for the `bigquery.saved` source

```json
{
  "options": {
    "accounts": { "work": { "billingProject": "work-project-1234" } },
    "savedQueries": {
      "revenue_today": {
        "sql": "SELECT order_date, SUM(total) AS revenue FROM `work-project-1234.analytics.orders` WHERE order_date = CURRENT_DATE() GROUP BY order_date",
        "maxBytes": "1GiB"
      }
    }
  }
}
```

The source's scope's `queries` names the ones a person confirmed; `saved_list` lists every saved query with its SQL and
a free estimate. `CURRENT_DATE()` and other per-call functions make a query uncacheable: set `allowUncached: true` if
every read may bill.

### Headless machine

```json
{ "options": { "accounts": { "default": { "mode": "token", "tokenEnv": "GOOGLE_ACCESS_TOKEN", "billingProject": "work-project-1234" } } } }
```

A token account holds no refresh token and is always Read. Set the variable from your secret store; never write the
token into the config.
