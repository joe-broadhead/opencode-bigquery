// The bind-time estimate of design §10: `jobs.query` with dryRun, used only for a saved query's set-up, which names
// no tables and has no accuracy (https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query). It is the one
// place jobs.query may be used; the read path and every run are jobs.insert.
import { describe, expect, test } from "vitest"
import { portFor, PROJECT, withFake } from "./support.js"
import { queryRequest } from "./support.js"

const signal = () => new AbortController().signal
const queries = `/bigquery/v2/projects/${PROJECT}/queries`

describe("the estimate", () => {
  test("is jobs.query with dryRun, the query, its parameters and the location", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "POST", path: queries }, { status: 200, body: { kind: "bigquery#queryResponse", jobComplete: true, statementType: "SELECT", totalBytesProcessed: "1234567", totalBytesBilled: "0", cacheHit: false } })
      const { port } = portFor(fake)

      const answer = await port.estimate(queryRequest({ params: [{ name: "id", parameterType: { type: "INT64" }, parameterValue: "1" }], location: "EU" }), signal())

      expect(answer).toEqual({ statementType: "SELECT", totalBytesProcessed: 1234567 })
      const body = fake.requests[0]!.body as { dryRun: boolean; maxResults: number; useLegacySql: boolean; query: string; parameterMode: string; location: string }
      expect(body).toMatchObject({ dryRun: true, maxResults: 0, useLegacySql: false, query: queryRequest().sql, parameterMode: "NAMED", location: "EU" })
      expect(fake.requests[0]!.path).toBe(queries)
    })
  })

  test("an answer with no bytes or type is empty, not a guess", async () => {
    await withFake(async (fake) => {
      fake.answer({ method: "POST", path: queries }, { status: 200, body: { kind: "bigquery#queryResponse", jobComplete: true } })
      const { port } = portFor(fake)
      await expect(port.estimate(queryRequest(), signal())).resolves.toEqual({})
    })
  })
})
