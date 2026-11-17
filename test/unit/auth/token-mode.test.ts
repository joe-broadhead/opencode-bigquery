// `token` mode (design §3.2): a variable's access token, no refresh, and an identity only when Google's token-info
// names and verifies it (design §10's `probe`: `verified: false` when Google does not report it).
import { describe, expect, it } from "vitest"
import { createAuthPort } from "../../../src/auth/index.js"
import { loadOptions } from "../../../src/options.js"
import { FakeTokenEndpoint } from "./fake.js"

const now = () => Date.parse("2026-11-17T12:00:00Z")
const signal = new AbortController().signal
const options = () => loadOptions({ accounts: { ci: { mode: "token", tokenEnv: "BIGQUERY_CI_TOKEN", billingProject: "invented-proj" } } })

describe("token mode", () => {
  it("reads the variable on every call, refreshes nothing, and claims no scopes", async () => {
    const endpoint = new FakeTokenEndpoint()
    const env = { BIGQUERY_CI_TOKEN: "ya29.invented-token-one" }
    const auth = createAuthPort({ options: options(), fetch: endpoint.fetch, now, env, stateDir: "/invented/never-written" })
    const first = await auth.token("ci", signal)
    expect(first.token).toBe("ya29.invented-token-one")
    expect(first.scopes).toEqual([])
    env.BIGQUERY_CI_TOKEN = "ya29.invented-token-two"
    expect((await auth.token("ci", signal)).token).toBe("ya29.invented-token-two")
    expect(endpoint.tokenRequests).toEqual([])
  })

  it("refuses an empty variable with AUTH_REQUIRED and names it", async () => {
    const endpoint = new FakeTokenEndpoint()
    const auth = createAuthPort({ options: options(), fetch: endpoint.fetch, now, env: {}, stateDir: "/invented/never-written" })
    const error = await auth.token("ci", signal).catch((value: unknown) => value)
    expect(error).toMatchObject({ code: "AUTH_REQUIRED" })
    expect((error as Error).message).toContain("BIGQUERY_CI_TOKEN")
  })

  it("takes a verified email from token info, and says unverified when Google does not answer", async () => {
    const endpoint = new FakeTokenEndpoint()
    const env = { BIGQUERY_CI_TOKEN: "ya29.invented-token" }
    const auth = createAuthPort({ options: options(), fetch: endpoint.fetch, now, env, stateDir: "/invented/never-written" })
    expect(await auth.identity("ci", signal)).toEqual({ email: "ada@example.invalid", verified: true })
    expect(endpoint.requests.some((request) => request.url.includes("/tokeninfo"))).toBe(true)

    const silent = new FakeTokenEndpoint().answer(() => ({ status: 401, body: { error: "invalid_token" } }))
    const other = createAuthPort({ options: options(), fetch: silent.fetch, now, env, stateDir: "/invented/never-written" })
    expect(await other.identity("ci", signal)).toEqual({ verified: false })
  })

  it("stops with CANCELLED when its signal is aborted", async () => {
    const endpoint = new FakeTokenEndpoint()
    const auth = createAuthPort({ options: options(), fetch: endpoint.fetch, now, env: { BIGQUERY_CI_TOKEN: "ya29.invented-token" }, stateDir: "/invented/never-written" })
    const aborted = new AbortController()
    aborted.abort()
    await expect(auth.identity("ci", aborted.signal)).rejects.toMatchObject({ code: "CANCELLED" })
  })
})
