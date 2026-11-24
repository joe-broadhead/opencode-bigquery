# Security

## Supported versions

Only the latest release is supported.

## Reporting a vulnerability

Report a vulnerability privately through GitHub's security advisories for this repository, not in a public issue.

## Data handling

### Network access

The plugin's own requests go only to Google: BigQuery's REST API (`bigquery.googleapis.com`) and Google's OAuth
endpoints (`oauth2.googleapis.com`, `accounts.google.com`). The opt-in `adc` mode also reads the environment's
Application Default Credentials (a key file, gcloud's file, or the metadata server), and those credential types call
`iamcredentials.googleapis.com` when impersonating a service account and `sts.googleapis.com` for an external-account
(WIF) credential, plus whatever token source that credential itself names. No other request goes anywhere else.

`/bigquery-status` and the TUI dialog make no request to Google: they read OpenCode's state, the plugin's options and
the local spend ledger. `bigquery_status` reads each account's level (which may refresh its token once in a process, a
request to Google's OAuth token endpoint) and runs the free IAM check once after a Read sign-in and with `include:
["iam"]`.

### Credentials

The plugin keeps no secret in its options. An interactive sign-in's refresh token is OpenCode's to store; access tokens
stay in memory and are never written. The DPoP key that binds the refresh token to this device is the plugin's own file,
`$XDG_STATE_HOME/bigquery-plugin/keys/<alias>.jwk`, mode 0600 in a 0700 folder.

The plugin never calls Google's token revocation endpoint. Google revokes every token of the OAuth client's project at
once, which would sign you out of other apps on the same client; replacing a sign-in and signing out are local instead.

### Untrusted content

Rows, names, descriptions, view and routine bodies, labels, job SQL and Google's error text are data, never
instructions. A `message` and a `next` step are built from codes and validated identifiers only; Google's text goes into
`googleError` with `trust: "untrusted"`, and any data Google returns sits under a result that carries
`trust: "untrusted"`.

### Spend ledger

`$XDG_STATE_HOME/bigquery-plugin/spend.jsonl` holds one line per finished job: the time, the account, the project and
location, the job id, the bytes billed, the tool and a hash of the session id. It never holds a row, a token or a
session id.

## Residual risks

1. **A Read account's token can change BigQuery data outside this plugin.** At Read Google issues a token that can change
   data wherever the account may; the plugin never uses it to, but a process running as you that reads both OpenCode's
   credential store and the plugin's key file can. For Google itself to refuse changes, grant only
   `roles/bigquery.jobUser` on the billing project and `roles/bigquery.dataViewer` on the data.
2. **An agent that controls your signed-in browser could complete Google's sign-in.** The browse plugin's rules require
   a handoff for sign-ins; nothing in this plugin can enforce that.
3. **The key is a file, not the OS keystore.** Keeping it in the macOS Keychain or libsecret would be closer to Google's
   device-binding advice; it needs a native module or helper and is not in this version.

## Permissions

The default rules come from the `access` option. An agent defined only in your config gets no block, and
`/bigquery-status` names it with the block to paste. With `access: "all"` every tool runs without asking, changes
included; the plan-then-commit step still shows a preview and needs a Read and write sign-in.

## Scripts

Scripts call the read tools through the tools RPC as a session and its agent; only a prior explicit `allow` runs, and an
`ask` is refused. A script can never run an uncapped-read plan, which only a session's tool may run after showing its
preview.
