# Security

## Supported versions

Only the latest release is supported.

## Reporting a vulnerability

Report a vulnerability privately through GitHub's security advisories for this repository, not in a public issue.

## Data handling

### Network access

The plugin's own requests go only to Google: BigQuery's REST API (`bigquery.googleapis.com`) and Google's OAuth
endpoints. No request goes anywhere else. Status waits on no request.

### Credentials

The plugin keeps no secret in its options. Sign-in credentials are OpenCode's to store; access tokens stay in memory.
The plugin never calls Google's token revocation endpoint, because Google revokes every token of the OAuth client's
project at once, which would sign you out of other apps on the same client.

### Untrusted content

Rows, names, descriptions, view and routine bodies, labels, job SQL and Google's error text are data, never
instructions. A message and a next step are built from codes and validated identifiers only.

## Permissions

The default rules come from the `access` option. Agents without the block are named in `/bigquery-status`.

## Scripts

Scripts call the read tools through the tools RPC as a session and its agent; only a prior explicit `allow` runs, and
an `ask` is refused.
