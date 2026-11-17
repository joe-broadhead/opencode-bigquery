// Package A in a real embedded OpenCode host (design §14.3, L14): the `bigquery-<alias>` integration and its two-level
// form with the disclosure under Read; a real loopback sign-in through the plugin's listener; the write binding; the
// relay's hidden redirect fields and the host's client JSON; a re-sign-in's new key; and the commands. Nothing leaves
// the machine: Google's hosts are served by a loopback fake, and the host's close() fails the test otherwise.
import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { createAuthPort, registerAuth } from "../../src/auth/index.js"
import { DISCLOSURE, SCOPES } from "../../src/domain/levels.js"
import { readKey } from "../../src/auth/keys.js"
import { loadOptions } from "../../src/options.js"
import { inventedIdToken } from "../unit/auth/fake.js"
import { freePort, loopbackGet } from "../unit/auth/loopback.js"
import { cleanup, startHost, until, type Host } from "./harness.js"

afterAll(cleanup)

const CLIENT_ID = "invented.apps.googleusercontent.com"
const CLIENT_SECRET = "GOCSPX-invented-client-secret"
const CODE = "4/invented-host-authorization-code"

interface FakeRequest {
  readonly path: string
  readonly grant?: string
  readonly dpop: boolean
  readonly form: Readonly<Record<string, string>>
}

/** Google's token and token-info endpoints, on loopback; the host's router sends oauth2.googleapis.com here. */
function fakeGoogle() {
  const requests: FakeRequest[] = []
  const state = {
    scopes: [SCOPES.openid, SCOPES.email, SCOPES.bigquery] as string[],
    clientId: CLIENT_ID,
    refresh: "1//invented-host-refresh-token",
  }
  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.pathname === "/tokeninfo") return Response.json({ email: "ada@example.invalid", email_verified: true })
    if (url.pathname !== "/token") return Response.json({ error: "not_found" }, { status: 404 })
    const text = await request.text()
    const form: Record<string, string> = {}
    for (const [key, value] of new URLSearchParams(text)) form[key] = value
    const grant = form["grant_type"]
    const dpop = request.headers.get("DPoP") !== null
    requests.push({ path: url.pathname, ...(grant !== undefined ? { grant } : {}), dpop, form })
    if (grant === "authorization_code") {
      return Response.json(
        {
          access_token: "ya29.invented-host-access-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: state.scopes.join(" "),
          refresh_token: state.refresh,
          id_token: inventedIdToken({ clientId: state.clientId, email: "ada@example.invalid" }),
        },
        { headers: { "DPoP-Nonce": "nonce-one" } },
      )
    }
    // The deliberate proof-less refresh: a 400 is what "bound" means.
    if (!dpop) return Response.json({ error: "invalid_request", error_description: "DPoP proof required" }, { status: 400 })
    return Response.json(
      {
        access_token: "ya29.invented-host-access-token-refreshed",
        expires_in: 3600,
        token_type: "Bearer",
        scope: state.scopes.join(" "),
        id_token: inventedIdToken({ clientId: state.clientId, email: "ada@example.invalid" }),
      },
      { headers: { "DPoP-Nonce": "nonce-two" } },
    )
  }
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler })
  // The auth flow's token endpoint: the fake itself, not the host's global router, so the sign-in is deterministic on
  // every architecture. It is a `fetch` function (a URL and init), while Bun.serve hands its handler a Request.
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => handler(new Request(input, init))) as typeof globalThis.fetch
  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    state,
    fetch: fakeFetch,
    close: () => server.stop(true),
  }
}

type FormAnswer = { readonly [x: string]: string | number | boolean | readonly string[] }

async function connect(host: Host, answer: FormAnswer) {
  return (
    await host.client.integration.oauth.connect({
      integrationID: "bigquery-default",
      methodID: "google",
      answer,
      location: host.location,
    })
  ).data
}

async function complete(host: Host, attempt: { readonly attemptID: string }) {
  await until("the Google sign-in completes", async () => (await host.client.integration.oauth.status({ integrationID: "bigquery-default", attemptID: attempt.attemptID, location: host.location })).data.status !== "pending", 30_000)
  const status = (await host.client.integration.oauth.status({ integrationID: "bigquery-default", attemptID: attempt.attemptID, location: host.location })).data
  if (status.status !== "complete") throw new Error(`the sign-in did not complete: ${status.status === "failed" ? status.message : status.status}`)
  const connection = await host.probe().integration.connection.active("bigquery-default")
  if (!connection) throw new Error("the host has no active connection after the sign-in")
  const credential = await host.probe().integration.connection.resolve(connection)
  if (!credential || credential.type !== "oauth") throw new Error("the host has no OAuth credential after the sign-in")
  return credential
}

/** A real loopback GET to the sign-in's listener, with the code and state Google would send. */
async function callback(url: string): Promise<{ readonly status: number; readonly body: string }> {
  const authorize = new URL(url)
  const state = authorize.searchParams.get("state")!
  const redirect = authorize.searchParams.get("redirect_uri")!
  return await loopbackGet(`${redirect}/?code=${encodeURIComponent(CODE)}&state=${encodeURIComponent(state)}`)
}

function stateDir(): string {
  return join(process.env.XDG_STATE_HOME!, "opencode-bigquery")
}

describe("package A in a host", () => {
  test("registers the form with the disclosure, signs in at Read and write, and binds the level to Google's grant", async () => {
    const fake = fakeGoogle()
    const host = await startHost({ fake })
    try {
      const options = loadOptions({ accounts: { default: { billingProject: "invented-proj" } } })
      await registerAuth(host.probe(), { options, fetch: fake.fetch, stateDir: stateDir() })

      const info = (await host.client.integration.get({ integrationID: "bigquery-default", location: host.location })).data
      expect(info.name).toBe("Google Cloud (BigQuery)")
      expect(info.methods).toHaveLength(1)
      const method = info.methods[0] as { type: string; label: string; form: readonly { key: string; default?: unknown; options?: { value: string; description: string }[]; required?: boolean; hidden?: boolean }[] }
      expect(method.type).toBe("oauth")
      const access = method.form.find((field) => field.key === "access")!
      const read = access.options!.find((option) => option.value === "read")!
      expect(access.default).toBe("read")
      expect(read.description).toContain(DISCLOSURE.bound)
      expect(read.description).toContain(DISCLOSURE.formSuffix)
      expect(method.form.find((field) => field.key === "clientJson")?.hidden).toBe(true)
      expect(method.form.find((field) => field.key === "redirectUri")?.hidden).toBe(true)

      fake.state.scopes = [SCOPES.openid, SCOPES.email, SCOPES.bigquery, SCOPES.writeMarker]
      const attempt = await connect(host, { access: "write", confirmWrite: true, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
      const url = new URL(attempt.url)
      expect(url.searchParams.get("prompt")).toBe("consent")
      expect(url.searchParams.has("include_granted_scopes")).toBe(false)
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
      expect(url.searchParams.get("scope")!.split(" ")).toContain(SCOPES.writeMarker)

      expect((await callback(attempt.url)).status).toBe(200)
      const credential = await complete(host, attempt)
      expect(credential.access).toBe("")
      expect(credential.refresh).toBe("1//invented-host-refresh-token")
      const metadata = credential.metadata as { record: { level: string; acknowledged: boolean; binding: string; keyId: string; email?: string }; scopes: string[] }
      expect(metadata.record).toMatchObject({ level: "write", acknowledged: true, binding: "bound", email: "ada@example.invalid" })
      expect(metadata.scopes).toContain(SCOPES.writeMarker)

      // The key is 0600 in a 0700 folder under the plugin's state folder, and holds no token.
      const keyPath = join(stateDir(), "keys", "default.jwk")
      expect(statSync(keyPath).mode & 0o777).toBe(0o600)
      expect(statSync(join(stateDir(), "keys")).mode & 0o777).toBe(0o700)
      const keyFile = readFileSync(keyPath, "utf8")
      expect(keyFile).not.toContain("ya29.")
      expect(keyFile).not.toContain("1//")
      expect(JSON.parse(keyFile).kid).toBe(metadata.record.keyId)
      expect(readdirSync(stateDir())).toContain("keys")
      expect(readdirSync(join(stateDir(), "keys"))).toEqual(["default.jwk"])

      // The exchange carried a DPoP proof; the probe did not; no request ever reached /revoke.
      expect(fake.requests[0]).toMatchObject({ grant: "authorization_code", dpop: true })
      expect(fake.requests[1]).toMatchObject({ grant: "refresh_token", dpop: false })
      expect(fake.requests.every((request) => !request.path.includes("revoke"))).toBe(true)

      // Both checks, through the port the tools get: the record and the marker from this process's refresh.
      const port = createAuthPort({ options, fetch: fake.fetch, stateDir: stateDir() })
      expect(await port.level("default", new AbortController().signal)).toEqual({ level: "write" })
      expect(fake.requests.filter((request) => request.grant === "refresh_token").at(-1)!.dpop).toBe(true)
    } finally {
      await host.close()
      await fake.close()
    }
  }, 120_000)

  test("L14: signs in through the relay's hidden redirect fields and the host's client JSON", async () => {
    const fake = fakeGoogle()
    const host = await startHost({ fake })
    const port = await freePort()
    try {
      const options = loadOptions({ redirectUri: "https://relay.invalid/return", callbackPort: port, accounts: { default: { billingProject: "invented-proj" } } })
      await registerAuth(host.probe(), { options, fetch: fake.fetch, stateDir: stateDir() })
      fake.state.scopes = [SCOPES.openid, SCOPES.email, SCOPES.bigquery, SCOPES.writeMarker]
      const clientJson = JSON.stringify({ web: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uris: ["https://relay.invalid/return"] } })
      const attempt = await connect(host, {
        access: "write",
        confirmWrite: true,
        clientJson,
        // Jelly's relay fills these two hidden fields, as package.json's `signIns[0].relay` says.
        redirectUri: "https://relay.invalid/return",
        callbackPort: port,
      })
      const url = new URL(attempt.url)
      expect(url.searchParams.get("redirect_uri")).toBe("https://relay.invalid/return")
      expect(url.searchParams.get("prompt")).toBe("consent")
      const state = url.searchParams.get("state")!
      // The relay forwards the browser to the local listener at the same path; that is what the host test does.
      const page = await loopbackGet(`http://127.0.0.1:${port}/return?code=${encodeURIComponent(CODE)}&state=${encodeURIComponent(state)}`)
      expect(page.status).toBe(200)
      const credential = await complete(host, attempt)
      expect((credential.metadata as { record: { level: string; binding: string } }).record).toMatchObject({ level: "write", binding: "bound" })
    } finally {
      await host.close()
      await fake.close()
    }
  }, 120_000)

  test("a Read sign-in after a Read and write one replaces the key and lowers the level", async () => {
    const fake = fakeGoogle()
    const host = await startHost({ fake })
    try {
      const options = loadOptions({ accounts: { default: { billingProject: "invented-proj" } } })
      await registerAuth(host.probe(), { options, fetch: fake.fetch, stateDir: stateDir() })
      fake.state.scopes = [SCOPES.openid, SCOPES.email, SCOPES.bigquery, SCOPES.writeMarker]
      const write = await connect(host, { access: "write", confirmWrite: true, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
      await callback(write.url)
      const first = await complete(host, write)
      const firstKey = (first.metadata as { record: { keyId: string } }).record.keyId

      fake.state.scopes = [SCOPES.openid, SCOPES.email, SCOPES.bigquery]
      fake.state.refresh = "1//invented-host-refresh-token-read"
      const read = await connect(host, { access: "read", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
      await callback(read.url)
      const second = await complete(host, read)
      const secondKey = (second.metadata as { record: { keyId: string; level: string } }).record.keyId
      expect((second.metadata as { record: { level: string } }).record.level).toBe("read")
      expect(second.refresh).toBe("1//invented-host-refresh-token-read")
      expect(secondKey).not.toBe(firstKey)
      expect(JSON.parse(readFileSync(join(stateDir(), "keys", "default.jwk"), "utf8")).kid).toBe(secondKey)
      // The old key is gone: its record's keyId no longer names a file, so the old refresh token cannot mint.
      expect(readKey(stateDir(), "default", firstKey)).toBeUndefined()
      expect(readKey(stateDir(), "default", secondKey)?.keyId).toBe(secondKey)
      expect(fake.requests.every((request) => !request.path.includes("revoke"))).toBe(true)

      const port = createAuthPort({ options, fetch: fake.fetch, stateDir: stateDir() })
      expect(await port.level("default", new AbortController().signal)).toMatchObject({ level: "read", refusal: "ACCOUNT_READ_ONLY" })
    } finally {
      await host.close()
      await fake.close()
    }
  }, 120_000)

  test("registers /bigquery-doctor and /bigquery-signout", async () => {
    const fake = fakeGoogle()
    const host = await startHost({ fake })
    try {
      const options = loadOptions({ accounts: { default: { billingProject: "invented-proj" } } })
      const registration = await registerAuth(host.probe(), { options, fetch: fake.fetch, stateDir: stateDir() })
      const commands = (await host.probe().command.list()).data.map((command) => command.name)
      expect(commands).toContain("bigquery-doctor")
      expect(commands).toContain("bigquery-signout")
      await registration.dispose()
    } finally {
      await host.close()
      await fake.close()
    }
  }, 120_000)
})
