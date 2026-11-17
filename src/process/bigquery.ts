// Package B: the BigQuery port over fetch (design §5.1 step 9, §8): retries, client job ids and the 409 join, the
// concurrency caps, Stop → jobs.cancel, value conversion and paging. Day 0 wires the unbuilt port.
import type { Options } from "../options.js"
import type { AuthPort, BigQueryPort } from "../ports.js"
import { unbuilt } from "../unbuilt.js"

export interface BigQueryDeps {
  readonly options: Options
  readonly auth: AuthPort
  readonly fetch: typeof globalThis.fetch
}

export function createBigQueryPort(_deps: BigQueryDeps): BigQueryPort {
  return unbuilt<BigQueryPort>("BigQuery")
}
