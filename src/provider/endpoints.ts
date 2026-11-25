// Every endpoint this plugin names, in one file: the provider's URL is named once (plugin standard §4 rule 12). The
// transport and the sign-in read these constants; no other file holds a URL.

/** BigQuery's REST base (v2). */
export const BIGQUERY_API = "https://bigquery.googleapis.com/bigquery/v2";

/** Google's OAuth token endpoint: the code exchange and the refresh, with DPoP proofs. */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Google's authorization endpoint. */
export const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";

/** Google's token-info endpoint, for the identity a `token` account's access token names. */
export const GOOGLE_TOKEN_INFO_URL = "https://oauth2.googleapis.com/tokeninfo";

/** The hosts a call reaches, for docs and tests. */
export const GOOGLE_HOSTS: readonly string[] = ["bigquery.googleapis.com", "oauth2.googleapis.com", "accounts.google.com"];
