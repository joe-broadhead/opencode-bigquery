// The fake itself: the queue per route, its default, the unrouted 501, latency, a mid-page failure, the token endpoint
// with the scopes a refresh returns, and request recording that keeps the authorization header's value out of a test.
import { describe, expect, test } from "vitest"
import { loadFixtures, replay, startFake } from "../../fake/bigquery.js"
import { revokeRequests } from "../../fake/server.js"

const TABLE = "/bigquery/v2/projects/invented-project/datasets/invented_dataset/tables/invented_table"
const table = { tableReference: { projectId: "invented-project", datasetId: "invented_dataset", tableId: "invented_table" }, type: "TABLE" }

describe("the fake Google server", () => {
  test("answers from the route's queue, then its default, then refuses as unrouted", async () => {
    const fake = await startFake()
    try {
      fake.enqueue({ method: "GET", path: TABLE }, { status: 200, body: table }, { status: 503, body: { error: { code: 503, message: "down", errors: [{ reason: "backendError" }] } } })
      expect((await request(fake, TABLE)).status).toBe(200)
      expect((await request(fake, TABLE)).status).toBe(503)
      expect((await request(fake, TABLE)).status).toBe(501)
      fake.answer({ method: "GET", path: TABLE }, { status: 200, body: table })
      expect((await request(fake, TABLE)).status).toBe(200)
      const unrouted = await request(fake, "/bigquery/v2/projects/nothing")
      expect(unrouted.status).toBe(501)
      expect(await unrouted.json()).toMatchObject({ error: { errors: [{ reason: "fakeUnrouted" }] } })
    } finally {
      await fake.close()
    }
  })

  test("answers a token refresh with the scopes it was given, on the OAuth host", async () => {
    const fake = await startFake()
    try {
      fake.refreshScopes(["openid", "https://www.googleapis.com/auth/bigquery"])
      const answer = await fetch(`${fake.origin}/token`, { method: "POST" })
      expect(await answer.json()).toMatchObject({ token_type: "Bearer", scope: "openid https://www.googleapis.com/auth/bigquery" })
      expect(fake.requests[0]).toMatchObject({ host: "oauth2.googleapis.com", path: "/token", method: "POST" })
    } finally {
      await fake.close()
    }
  })

  test("records the authorization header by name only, and every other header as sent", async () => {
    const fake = await startFake()
    try {
      fake.answer({ method: "GET", path: TABLE }, { status: 200, body: table })
      await fetch(`${fake.origin}${TABLE}`, { headers: { authorization: "Bearer a-real-looking-token", "x-test": "value" } })
      expect(fake.requests[0]!.headers).toMatchObject({ authorization: "sent", "x-test": "value" })
      expect(JSON.stringify(fake.requests[0])).not.toContain("a-real-looking-token")
      expect(fake.requests[0]!.host).toBe("bigquery.googleapis.com")
    } finally {
      await fake.close()
    }
  })

  test("waits a scripted delay, and can fail one page mid-stream", async () => {
    const fake = await startFake()
    try {
      fake.enqueue({ method: "GET", path: TABLE }, { status: 200, delayMs: 40, body: table }, { status: 500, body: { error: { code: 500, message: "mid-page", errors: [{ reason: "backendError" }] } } })
      const started = Date.now()
      expect((await request(fake, TABLE)).status).toBe(200)
      expect(Date.now() - started).toBeGreaterThanOrEqual(30)
      expect((await request(fake, TABLE)).status).toBe(500)
    } finally {
      await fake.close()
    }
  })

  test("replays a fixture, and a revoked request would be visible", async () => {
    const fake = await startFake()
    try {
      const fixture = loadFixtures().find((entry) => entry.name === "table-get")!
      replay(fake, fixture)
      const answer = await request(fake, fixture.request.path)
      expect(answer.status).toBe(200)
      expect(await answer.json()).toMatchObject({ tableReference: { tableId: "invented_table" } })

      await fetch(`${fake.origin}/revoke`, { method: "POST" })
      expect(revokeRequests(fake.requests)).toHaveLength(1)
      expect(revokeRequests(fake.requests.slice(0, -1))).toHaveLength(0)
    } finally {
      await fake.close()
    }
  })
})

const request = (fake: { origin: string }, path: string) => fetch(`${fake.origin}${path}`)
