# Accounts

The plugin holds the credentials, so its mechanism is `integration`: one OpenCode integration per alias, `bigquery` for
`default` and `bigquery-<alias>` for any other. `plugin-kit docs` writes the mechanism and the profile fields from
`capabilities`; edit the manifest, never the generated text.

<!-- generated:accounts -->
Accounts are held by the **integration** mechanism: the plugin holds the credentials.

| Field | Type | Required |
|---|---|---|
| `mode` | `interactive` \| `token` | no |
| `level` | `read` \| `write` | no |
| `billingProject` | string | no |
| `location` | string | no |
| `datasets` | object | no |
| `inline` | object | no |
| `oauthClient` | object | no |
| `tokenEnv` | string | no |
| `scopes` | array | no |
<!-- /generated:accounts -->

## Signing in

1. Add the alias to `options.accounts` with at least its `billingProject`.
2. Run `/connect` in OpenCode and choose the integration for that alias: **BigQuery** for `default`, **BigQuery (work)**
   for `work`.
3. Approve every scope shown. The plugin asks for `openid`, `userinfo.email` and `bigquery`; choosing Read and write adds
   `bigquery.insertdata`, which grants nothing more but which only Google's consent screen can grant.
4. `probe({ account: "work" })` confirms the alias: it answers the account's owner (`mailto:…`) and reads no content.

The access token stays in memory; OpenCode's credential store holds the refresh token. The refresh is bound to a device
key that the plugin keeps under `$XDG_STATE_HOME/bigquery-plugin/keys/`, outside the credential store. On a shared or
hosted machine, a token account (`mode: "token"`) avoids a stored refresh token entirely.

## Picking an account in a call

Every method that reads or changes BigQuery takes `account`:

```json
{ "sql": "SELECT COUNT(*) FROM `work-project-1234.analytics.orders`", "account": "work" }
```

With one account it may be left out. With several, leaving it out is `ACCOUNT_REQUIRED`, whose next step lists the
aliases; an alias the plugin does not have is `ACCOUNT_UNKNOWN`. A commit takes no `account` at all: it runs as the
account that made its plan, because the plan recorded it.

`status` shows every alias, its state (`ready`, `needs_sign_in`, `error`) and its owner once probed. A sign-in that
needs attention is reported there; a failed refresh is a redacted one-line reason, never a token.

## Levels and the dataset fence

A sign-in's level is Read or Read and write. Read runs every read and refuses every commit before Google is called. The
profile's `level` can lower an account to Read; it can never raise it. For Google itself to refuse changes, have an
administrator grant BigQuery Job User and Data Viewer, and nothing that can write.

The profile's `datasets` fence is checked on every path, sources included: an allow list confines every referenced
object and every change target, and a deny entry always wins. `inline.deny` keeps a dataset's rows out of the model, so
a query over it answers save-only.

## Cursors are per account

The `bigquery.jobs` cursor is bound to the plugin, the source, the account and the scope. A cursor `work` issued read
under `personal` is `CURSOR_INVALID`, never a silent restart. An app stores the cursor string; it never edits it.
