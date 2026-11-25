// The provider client: the one place a URL, a request shape or a Google failure is turned into the plugin's own types.
// `createProvider` builds the BigQuery client, the spend ledger and the clock the handlers share; the auth port comes
// from `src/auth/`.
import { randomUUID } from "node:crypto";
import { stateDirOf } from "../auth/keys.js";
import { createLedger } from "../guards/ledger.js";
import type { Options } from "../options.js";
import type { AuthPort, Clock, Ports } from "../ports.js";
import { createBigQueryPort } from "./bigquery.js";

export type { BigQueryPort, DryRunAnswer, JobStatus, Page, QueryJobRequest, ResultPage, RunRequest } from "../ports.js";
export { BIGQUERY_API, GOOGLE_AUTHORIZE, GOOGLE_HOSTS, GOOGLE_TOKEN_INFO_URL, GOOGLE_TOKEN_URL } from "./endpoints.js";

/** What a provider needs: the parsed options, the auth port, and the runtime's fetch. */
export interface ProviderRequest {
  readonly options: Options;
  readonly auth: AuthPort;
  readonly fetch: typeof globalThis.fetch;
  /** A test's clock and state folder; production uses the real ones. */
  readonly clock?: Clock;
  readonly stateDir?: string;
}

/** The clock: wall time, and the random job id a run carries so a retry joins it instead of running it twice. */
export const systemClock: Clock = { now: () => Date.now(), uuid: () => randomUUID() };

/** The provider client and the ports every handler shares. */
export function createProvider(request: ProviderRequest): Ports {
  const clock = request.clock ?? systemClock;
  const stateDir = request.stateDir ?? stateDirOf();
  return {
    bigquery: createBigQueryPort({ options: request.options, auth: request.auth, fetch: request.fetch }),
    auth: request.auth,
    ledger: createLedger({ stateDir }),
    clock,
  };
}
