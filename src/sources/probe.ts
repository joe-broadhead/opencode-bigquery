/**
 * `probe` (design §10): who the signed-in account is, for a source's consent. It reads no BigQuery content: the
 * identity comes from the stored `id_token` (interactive), the key or gcloud file's address (ADC), or Google's token-info
 * answer for a `token` account (package A's `identity`).
 *
 * The answer is the source contract's `{ source, account, owner, trust }`. `owner.id` is `mailto:<address>` when Google
 * reports one, the account's own `bigquery:account:<alias>` otherwise; `owner.verified: false` is never written, because
 * a v0.1.x consumer refuses that key (a contract request in this pull request's description), so the answer never
 * claims more than the id says.
 *
 * The account is the one the registry resolved; several accounts with none named is `INPUT_INVALID`, never a silent
 * first account.
 */
import { probeResult, type ProbeResult } from "@we-the-rebel-alliance/source-contract/events"
import type { SourceDeps } from "./events.js"
import { sourceError } from "./errors.js"

/** The short source names a probe answers for, from the descriptor's `input.source` or the source id. */
const SOURCES: Readonly<Record<string, string>> = {
  jobs: "jobs",
  saved: "saved",
  "bigquery.jobs": "jobs",
  "bigquery.saved": "saved",
}

export async function probeSource(deps: SourceDeps, input: unknown): Promise<ProbeResult> {
  const raw = (input ?? {}) as Record<string, unknown>
  const named = raw["source"]
  const source = named === undefined ? "jobs" : typeof named === "string" ? SOURCES[named] : undefined
  if (source === undefined) {
    throw sourceError("SOURCE_UNKNOWN", `This plugin has no source "${String(named)}".`, "Pass source jobs or source saved.")
  }
  if (deps.account === "*") {
    throw sourceError("INPUT_INVALID", "The probe named no account, and this plugin has several.", "Pass the account to probe, as the source's binding names it.")
  }
  const identity = await deps.ports.auth.identity(deps.account, deps.call.signal)
  const email = identity.email
  const owner = email !== undefined ? { id: `mailto:${email}`, label: email } : { id: `bigquery:account:${deps.account}`, label: `BigQuery account ${deps.account}` }
  // One probe for the plugin, called per source: the contract's `sources.probe` names the method once, and the reader
  // sends the item's `input.source` with it (`{ source, account }`), which the answer names back.
  return probeResult({ source, account: deps.account, owner })
}
