/**
 * The read path's local scope check (design §3, §14.1 "scope checks"). Both levels request `bigquery`; a token that
 * carries `cloud-platform` can use BigQuery too, which is what a gcloud user credential gets by default, so a headless
 * account is accepted with either. Nothing is sent to Google before the check: a grant missing both is
 * `AUTH_SCOPE_MISSING`.
 */
import { SCOPES } from "../domain/levels.js"

/** The scopes BigQuery accepts for `jobs.insert`: `bigquery`, or `cloud-platform` (Google's jobs.insert page, §17 [4a]). */
export const BIGQUERY_SCOPES: readonly string[] = [SCOPES.bigquery, "https://www.googleapis.com/auth/cloud-platform"]

/** The scopes the plugin itself requests at either level, without a person's extra `scopes` option. */
const OWN_SCOPES: readonly string[] = [SCOPES.openid, SCOPES.email, SCOPES.bigquery, SCOPES.writeMarker]

/** True when one of the granted scopes lets BigQuery run a job. */
export function canUseBigQuery(granted: readonly string[]): boolean {
  return BIGQUERY_SCOPES.some((scope) => granted.includes(scope))
}

/** True when the credential has scopes the plugin's own request never asks for, such as `cloud-platform` (SCOPE_WIDER_THAN_LEVEL). */
export function widerThanLevel(granted: readonly string[]): readonly string[] {
  return granted.filter((scope) => !OWN_SCOPES.includes(scope) && scope !== "https://www.googleapis.com/auth/cloud-platform")
}

/** True when the credential carries `cloud-platform`, the common gcloud ADC default. */
export function hasCloudPlatform(granted: readonly string[]): boolean {
  return granted.includes("https://www.googleapis.com/auth/cloud-platform")
}

/** The scopes in `required` the grant lacks. */
export function missingScopes(granted: readonly string[], required: readonly string[]): readonly string[] {
  return required.filter((scope) => !granted.includes(scope))
}
