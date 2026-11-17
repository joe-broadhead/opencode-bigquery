# Auth and accounts

How `@joe-broadhead/opencode-bigquery` signs in to Google, what each level can do, and where every credential lives. The
design's §3 and §3.1 are the source; this page is the version a person reads before connecting an account, and the module
map is [docs/architecture.md](architecture.md).

## Levels

`accounts` maps an alias to settings; with none there is one `default` interactive account. Both levels request
`openid`, `https://www.googleapis.com/auth/userinfo.email` and `https://www.googleapis.com/auth/bigquery`.

| Level | How a person gets it | What it can do | What it cannot |
| --- | --- | --- | --- |
| `read` (default) | Sign in and choose **Read** (the form's default). | Every read tool with all guards (the fence, the side-effect and cap checks, Stop cancels, idempotent runs); `bigquery_save`; `bigquery_cancel` on this account's jobs; `bigquery_plan` previews with `committable: false`. | Commit anything: refused with `ACCOUNT_READ_ONLY` before any Google call. |
| `write` | Sign in and choose **Read and write**, tick "I understand this allows changes", then approve Google's consent screen, which lists the extra line "Insert data into Google BigQuery". | Plans and commits, under the `access` setting. | — |

The `level` option on an account can only **lower** an account (`write` → `read`). It can never raise one. Headless modes
(`adc`, `token`) have no sign-in to bind a level to, so in this version they are read-only, full stop; `level: "write"` on
one is refused when the options load (`OPTIONS_INVALID`).

### The disclosure

At **Read**, Google issues a token that can change BigQuery data wherever your Google account is allowed to; this plugin
never uses it to, but a program that can read both OpenCode's credential store and this plugin's key file could. For
Google itself to refuse changes, have your admin grant you only BigQuery Job User and Data Viewer.

When Google does **not** bind the refresh token to this device, the wording drops the key file: "… but a program that can
read OpenCode's credential store could. …". The sign-in records which case applies (`bound` or `unbound`) and status
shows it. The form, which is shown before Google answers, carries the bound sentence plus "(if Google does not bind the
token to this device, reading the credential store alone is enough; status will say)".

### How the write level is bound

An account is `write` only when **both** hold:

1. its sign-in record — written by this plugin's sign-in method, only when the form's **Read and write** was chosen and
   acknowledged — says `write`; and
2. the `scope` field of Google's answer to **this process's most recent token refresh** contains
   `https://www.googleapis.com/auth/bigquery.insertdata`.

The plugin keeps access tokens in memory only, so the first commit in each OpenCode process follows a fresh refresh; the
scope list is taken from Google's answer, never from the stored record. The `insertdata` marker adds no power that
`bigquery` does not already have. What it does is require a person at Google's consent screen: no local option, rule or
file edit can make Google return it.

An agent (or anything editing config) **can**:

- lower an account to `read` in config;
- loosen or tighten `access` and permission rules in a config file it may edit (as with any plugin);
- start a sign-in (`opencode auth login bigquery-<alias>`);
- run any read the read path allows, and save files.

It **cannot**:

- enable writes: no option, rule or edit of the sign-in record adds `insertdata` to the scopes Google returns;
- finish a write sign-in: it needs a browser sign-in the person completes with **Read and write** chosen and
  acknowledged;
- make the plugin send a non-verified statement on a `read` account.

## The sign-in

Each interactive account has its own integration, `bigquery-<alias>`. Open `/connect`, choose **Google Cloud
(BigQuery)**, fill in the form, and finish in your browser; from a terminal, `opencode auth login bigquery-<alias>` does
the same.

- **PKCE S256** on every authorization request, with a random `state` value.
- **`prompt=consent` on every sign-in**, Read included, so Google shows its consent screen and mints a new
  device-bound refresh token. It is never sent on a refresh. No sign-in sets `include_granted_scopes`, so a later Read
  sign-in returns a token without the write marker.
- **Redirect:** by default a loopback listener on `127.0.0.1` (a random port, or `callbackPort`). A host that serves
  OpenCode to a browser on another machine, Jelly included, supplies the relay's `redirectUri` and `callbackPort`
  through the form's hidden fields; the plugin then listens on `callbackPort` and accepts the relay's path.
- **Client precedence:** `accounts.<alias>.oauthClient`, then the plugin's `oauthClient`, then the client entered in the
  form, then the client of this alias's previous sign-in when it was entered in the form. With none, the sign-in is
  refused with `AUTH_CLIENT_REQUIRED`. No OAuth client ships in this package: a Desktop app client is yours, or your
  organisation's.
- **The host's client JSON:** Jelly fills the form's hidden `clientJson` field with its Google client, which may be a
  Web application client (`{"web": …}` with its redirect URIs). The plugin checks the redirect against those URIs before
  the browser opens.

### Token storage and DPoP

At each sign-in the plugin generates a new P-256 key and sends DPoP proofs to Google's token endpoint, so Google binds
the refresh token to that key.

- The key lives in the plugin's own state folder, `$XDG_STATE_HOME/opencode-bigquery/keys/<alias>.jwk`, mode 0600 inside
  a 0700 folder — apart from OpenCode's credential store.
- OpenCode's credential store holds the refresh token, the OAuth client and the sign-in record. **Access tokens stay in
  memory** and are never written by this plugin.
- A copied `auth.json` alone cannot mint tokens. A process running as you that reads both files can; the disclosure
  says so.
- **Proofs:** ES256; `typ: dpop+jwt`; the public JWK in the header; `htm` `POST`, `htu` Google's token endpoint, `iat`
  now. The code exchange's `jti` is `BASE64URL(SHA256(<authorization code>))`; every refresh uses a fresh random one.
  Google's `DPoP-Nonce` is cached per key and sent next; a `use_dpop_nonce` error is retried once with the nonce it
  carries.
- **Bound or not:** right after the code exchange the plugin makes one refresh **without** a proof. Google must answer
  400 for a bound token; a 200 means unbound. The sign-in records `bound` or `unbound`; the disclosure wording follows.
- **Replacing a sign-in:** each sign-in writes a new key at the same path and replaces the credential, so a previous
  bound refresh token can no longer mint tokens. OpenCode limits refresh tokens per client and account and retires the
  oldest, so very frequent re-sign-ins on a client shared with other apps can retire an old token elsewhere.
- **Never `/revoke`:** Google's revocation removes every scope the person granted the client's project, signing them out
  of every app on the same client, and no token can be revoked alone. Sign-out is local (see below).
- Keeping the key in the OS keystore (macOS Keychain, libsecret) would be closer to Google's device-binding advice; it
  needs a native module or helper binary and is not in this version.

### Session control

A Workspace admin may limit how long a session lasts for every app that uses Google Cloud scopes, `bigquery` included.
A refresh then fails with `invalid_grant` and a reauthentication subtype, the plugin answers `AUTH_REQUIRED` with "your
organisation requires signing in again every N hours" (N when Google states it), and sources answer `NEEDS_SIGN_IN`. The
fix is the admin's: add the OAuth client to the trusted apps and exempt it from the session limit.

## Headless modes

`adc` and `token` are opt-in, read-only, and never a fallback.

### `adc`: Application Default Credentials

The bundled `google-auth-library` finds `GOOGLE_APPLICATION_CREDENTIALS` (a service-account key, an external-account/WIF
configuration, or an impersonated service account), gcloud's ADC file, or the metadata server. `accounts.<alias>.impersonate`
mints a token for that service account. Keys and impersonation request `bigquery`.

- A gcloud user credential has the scopes it was created with, often `cloud-platform`, which is wider than BigQuery
  needs. Status and the doctor say `SCOPE_WIDER_THAN_LEVEL` and suggest the narrower login:
  `gcloud auth application-default login --scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/bigquery`.
- Inside a managed (hosted) engine, ADC is refused with `ADC_REFUSED` unless the operator sets `allowAdcInHost: true`.
- Nothing found is `ADC_UNAVAILABLE`, with the environment variable and the gcloud command named.

### `token`: an access token from the environment

The account names a variable (`tokenEnv`); its value is sent as the bearer token. There is no refresh and no known scope
list. Identity is reported only when Google's token-info endpoint names and verifies an email; otherwise the source
probe says `verified: false`.

## The IAM check, and what it cannot see

Recommended IAM for read-only use: `roles/bigquery.jobUser` on the billing project and `roles/bigquery.dataViewer` on the
datasets, and nothing that includes `bigquery.tables.updateData`, `bigquery.tables.create` or `bigquery.tables.delete`
(no `dataEditor`, `dataOwner`, basic Editor or Owner).

After a sign-in, `/bigquery-doctor` (and `bigquery_status({ include: ["iam"] })`) calls `tables.testIamPermissions` for
those three permissions on the first table of each fenced dataset, or with no fence on the first table of each dataset
in the billing project, up to 10. It is free and accepts `bigquery`, and it reports inherited grants. A hit is
`IDENTITY_CAN_WRITE`, naming the table and the permission.

The check's limit, stated with the warning: whether the identity may **create datasets at project level** cannot be
checked, because Resource Manager's `projects.testIamPermissions` needs scopes this plugin does not request.

## `/bigquery-doctor` and `/bigquery-signout`

- **`/bigquery-doctor`** runs one `projects.list`, one dry run of `SELECT 1`, one `datasets.list` on the billing project,
  the level check above and the IAM check. It reports `OK`, `AUTH_REQUIRED`, `AUTH_SCOPE_MISSING`, `AUTH_CLIENT_REQUIRED`,
  `ADC_REFUSED`, `ADC_UNAVAILABLE`, `WRITE_LEVEL_UNVERIFIED`, `WRITE_LEVEL_UNAVAILABLE`, `BILLING_PROJECT_REQUIRED`,
  `API_DISABLED`, `PERMISSION_DENIED` or `IDENTITY_CAN_WRITE`.
- **`/bigquery-signout [alias]`** deletes the account's DPoP key and forgets its in-memory tokens. A bound refresh token
  then cannot mint another token here or anywhere. The copy OpenCode holds is deleted in `/connect`, or with
  `opencode auth logout bigquery-<alias>`; the plugin has no public API that removes a host connection, so the command
  names that step rather than pretending. An unbound token stays valid at Google until it expires or you remove the app
  at <https://myaccount.google.com/permissions>, and the command says so. Google's `/revoke` is never called.

## Two residual risks

1. An agent that controls your signed-in browser could complete Google's sign-in. The browse plugin's rules require a
   handoff for sign-ins; nothing in this plugin can enforce that.
2. A process running as you that reads both OpenCode's credential store and this plugin's key file can use the token
   outside the plugin, where only IAM applies.
