# Security

## What leaves the machine

The plugin sends requests to Google only: `bigquery.googleapis.com` for BigQuery's REST API, `oauth2.googleapis.com`
for the token exchange and refresh, and `accounts.google.com` for the sign-in page. No request goes anywhere else, and
nothing is sent to a third party.

A request carries the SQL or the described statement, its parameters, the project and location, the byte cap and the
labels; and the account's bearer token in its `Authorization` header. It never carries another account's token. Google's
answer carries BigQuery data and its error text, both treated as untrusted.

## Scopes

| Level | Scopes |
|---|---|
| Read | `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/bigquery` |
| Read and write | the same, plus `https://www.googleapis.com/auth/bigquery.insertdata` |

`bigquery` is the scope BigQuery needs; `insertdata` grants nothing beyond it but marks a sign-in as Read and write at
Google's own consent screen. Extra scopes named in a profile are added only when the person signs in again. No scope
for Drive, Gmail or Cloud Storage is ever requested.

A profile can name extra `scopes`, such as `drive.readonly` for a Drive external table; they are requested at the next
sign-in; no other request asks for them.

## Redaction

- A status reason is redacted and cut to one line of at most 160 characters.
- A refusal's message and next step are built from the plugin's codes and validated identifiers, never from Google's
  text or from a row. Google's message reaches the model in `googleError`, marked `trust: "untrusted"`.
- A bus event carries `{ capability, account, reason }` and nothing else; the writer screens it for secrets.
- A credential never reaches a log, a fixture, a doc or status. A fixture that needs a person's address uses
  `example.test`/`example.com`.

## Plan, then commit

A change is a free dry run, a preview and a plan the person confirms:

1. the planner dry-runs the statement, classifies it from BigQuery's own answer, checks the dataset fence, and returns
   the preview (targets, referenced objects, bytes, cost, cap) and the private statement;
2. `register` mints a 128-bit plan id, keeps the answer for 15 minutes and stores it in memory only;
3. the commit takes `{ planId }` alone, runs as the account that planned it, requires the write level, and re-checks the
   statement with a fresh dry run; a change since the preview is `PLAN_CHANGED`, and the plan is spent once;
4. over RPC a non-read method needs a permission ask or a host-signed action grant; an allow rule alone is not a
   confirmation.

The commit runs with the plan's byte cap. A value the person did not see in the preview cannot change what the commit
writes.

## Local files

`save` writes only inside the project, the `resultsDir`, or an `allowedRoots` entry, compared as real paths so a link
cannot walk the write outside them. An existing file is not replaced unless `overwrite: true`. The file is written
beside the target and renamed into place, so a failure never leaves a half-written result.

## Credentials on this machine

OpenCode's credential store holds the refresh token; the plugin keeps its device (DPoP) key under
`$XDG_STATE_HOME/bigquery-plugin/keys/`, with owner-only permissions. Access tokens stay in memory. A token account
reads a short-lived token from an environment variable and keeps no refresh token at all. Removing the integration in OpenCode deletes the stored
credential; the device key stays under that folder until it is deleted, and a new sign-in writes a new key.

## Reporting a problem

See [SECURITY.md](../SECURITY.md).
