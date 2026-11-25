/**
 * `probe` (design §10): who the signed-in account is, for a source's consent. It reads no BigQuery content: the identity
 * comes from the stored sign-in record (interactive) or from Google's token-info answer for a `token` account.
 *
 * The answer is the contract's `{ source, account, owner, trust }`. `owner.id` is `mailto:<address>` when Google reports
 * one, the account's own `bigquery:account:<alias>` otherwise. The account is the one the register resolved; the source
 * the caller named is only echoed.
 */
import { type ProbeResult, probeResult } from "@we-the-rebel-alliance/plugin-contract/events";
import { sourceError } from "./errors.js";
import type { SourceDeps } from "./events.js";

/** The short source names a probe answers for, from the descriptor's `input.source` or the source id. */
const SOURCES: Readonly<Record<string, string>> = {
  jobs: "jobs",
  saved: "saved",
  "bigquery.jobs": "jobs",
  "bigquery.saved": "saved",
};

export async function probeSource(deps: SourceDeps, input: unknown): Promise<ProbeResult> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const named = raw["source"];
  const source = named === undefined ? "jobs" : typeof named === "string" ? SOURCES[named] : undefined;
  if (source === undefined) throw sourceError("SOURCE_UNKNOWN", `This plugin has no source "${String(named)}"`, "Pass source jobs or source saved.");
  const identity = await deps.ports.auth.identity(deps.account, deps.signal);
  const email = identity.email;
  const owner = email !== undefined ? { id: `mailto:${email}`, label: email } : { id: `bigquery:account:${deps.account}`, label: `BigQuery account ${deps.account}` };
  // One probe for the plugin, called per source: the contract's `sources.probe` names the method once, and the reader
  // sends the item's `input.source` with it (`{ source, account }`), which the answer names back.
  return probeResult({ source, account: deps.account, owner });
}
