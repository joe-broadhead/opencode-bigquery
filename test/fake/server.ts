/**
 * The fake Google server's interface: what package B's loopback fake (`test/fake/bigquery.ts`) implements and the host
 * tests use. It serves Google's two hosts (bigquery.googleapis.com and oauth2.googleapis.com) through the host tests'
 * fetch router (test/host/route-fetch.ts), replays sanitised fixtures with latency, 429s and mid-page failures, and
 * records every request. A request to a revocation endpoint fails the test: the plugin never revokes.
 */
import { REVOKE_ENDPOINTS } from "../../src/domain/levels.js"

export interface RecordedRequest {
  readonly method: string
  /** The Google host the request was for (the router rewrites it to the fake's origin). */
  readonly host: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  /** Header names only for `authorization` and `dpop`: a test asserts they were sent, never their values. */
  readonly headers: Readonly<Record<string, string>>
  readonly body?: unknown
  readonly at: number
}

/** One canned answer: a status, a JSON body, optional headers and a delay. */
export interface FakeAnswer {
  readonly status: number
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
  readonly delayMs?: number
}

/** Which requests an answer is for: a method and a path pattern, such as `POST /bigquery/v2/projects/:project/jobs`. */
export interface Route {
  readonly method: string
  readonly path: string | RegExp
  /** Only a dry run, or only a run, for jobs.insert. */
  readonly dryRun?: boolean
}

export interface FakeGoogleServer {
  /** The loopback origin the router sends Google's hosts to. */
  readonly origin: string
  readonly requests: readonly RecordedRequest[]
  /** Answers the next matching request with `answer` (a queue per route, then the route's default). */
  enqueue(route: Route, ...answers: readonly FakeAnswer[]): void
  /** Answers every matching request with `answer` once its queue is empty. */
  answer(route: Route, answer: FakeAnswer | ((request: RecordedRequest) => FakeAnswer)): void
  /** The token endpoint's refresh answer's `scope` from now on, as Google would return it. */
  refreshScopes(scopes: readonly string[]): void
  close(): Promise<void>
}

/** The revocation requests among `requests`: always none. */
export function revokeRequests(requests: readonly RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => REVOKE_ENDPOINTS.some((endpoint) => endpoint === `https://${request.host}${request.path}`))
}
