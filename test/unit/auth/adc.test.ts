// ADC and impersonation (design §3.2, L12): a service-account key, a gcloud user credential's wider scopes, an
// impersonated service account, the managed-host refusal, and the failure when nothing is found. The bundled library is
// replaced by this file's fake: nothing is loaded and nothing is fetched.
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createAuthPort } from "../../../src/auth/index.js"
import { ADC_SCOPES, adcToken, isManagedHost } from "../../../src/auth/adc.js"
import type { AdcClient, AdcCredentials, AdcLibrary, AdcTokenInfo } from "../../../src/auth/adc-library.js"
import { hasCloudPlatform, widerThanLevel } from "../../../src/auth/scopes.js"
import { SCOPES } from "../../../src/domain/levels.js"
import { loadOptions } from "../../../src/options.js"
import { FakeHost } from "./fake.js"

const now = () => Date.parse("2026-11-17T12:00:00Z")
const signal = new AbortController().signal

class FakeClient implements AdcClient {
  readonly calls: string[] = []
  constructor(
    private readonly answer: { readonly token?: string | null; readonly expires?: number } = {},
    private readonly info: AdcTokenInfo | Error = { scopes: ADC_SCOPES },
  ) {}
  async getAccessToken() {
    this.calls.push("getAccessToken")
    return { token: this.answer.token === undefined ? "ya29.invented-adc-token" : this.answer.token, ...(this.answer.expires !== undefined ? { res: { data: { expiry_date: this.answer.expires } } } : {}) }
  }
  async getTokenInfo(_token: string) {
    this.calls.push("getTokenInfo")
    if (this.info instanceof Error) throw this.info
    return this.info
  }
}

interface FakeLibrary {
  readonly library: AdcLibrary
  readonly constructed: { readonly scopes?: readonly string[] }[]
  readonly impersonated: { readonly targetPrincipal: string; readonly targetScopes: readonly string[] }[]
}

/** A fake google-auth-library: the GoogleAuth constructor, the source client and the impersonated client. */
function fakeLibrary(client: AdcClient | Error, credentials: AdcCredentials): FakeLibrary {
  const constructed: { readonly scopes?: readonly string[] }[] = []
  const impersonated: { readonly targetPrincipal: string; readonly targetScopes: readonly string[] }[] = []
  const source = () => {
    if (client instanceof Error) throw client
    return client
  }
  const GoogleAuth = class {
    constructor(options: { readonly scopes?: readonly string[] }) {
      constructed.push(options)
    }
    async getClient(): Promise<AdcClient> {
      if (client instanceof Error) throw client
      return client
    }
    async getCredentials(): Promise<AdcCredentials> {
      return credentials
    }
  }
  const Impersonated = class {
    constructor(options: { readonly sourceClient: AdcClient; readonly targetPrincipal: string; readonly targetScopes: readonly string[] }) {
      impersonated.push({ targetPrincipal: options.targetPrincipal, targetScopes: options.targetScopes })
    }
    async getAccessToken() {
      return source().getAccessToken()
    }
    async getTokenInfo(token: string) {
      const found = source()
      return found.getTokenInfo ? found.getTokenInfo(token) : { scopes: [] }
    }
  }
  return { library: { GoogleAuth: GoogleAuth as unknown as AdcLibrary["GoogleAuth"], Impersonated: Impersonated as unknown as AdcLibrary["Impersonated"] }, constructed, impersonated }
}

describe("ADC", () => {
  it("mints a key's token with the requested scopes, and takes the key's email", async () => {
    const client = new FakeClient({ expires: now() + 1_800_000 }, { scopes: [SCOPES.bigquery] })
    const fake = fakeLibrary(client, { type: "service_account", client_email: "invented@invented.iam.gserviceaccount.com" })
    const token = await adcToken({ library: fake.library, now, scopes: [SCOPES.bigquery] })
    expect(token).toMatchObject({ token: "ya29.invented-adc-token", expiresAt: now() + 1_800_000, email: "invented@invented.iam.gserviceaccount.com", verified: true })
    expect(token.scopes).toEqual([SCOPES.bigquery])
    expect(fake.constructed[0]!.scopes).toEqual([SCOPES.bigquery])
  })

  it("reports a gcloud user credential's wider scopes and its email", async () => {
    const client = new FakeClient({}, { email: "ada@example.invalid", verified_email: true, scopes: ["https://www.googleapis.com/auth/cloud-platform"] })
    const fake = fakeLibrary(client, { type: "authorized_user", client_id: "invented.apps.googleusercontent.com" })
    const token = await adcToken({ library: fake.library, now, scopes: [SCOPES.bigquery] })
    expect(token.email).toBe("ada@example.invalid")
    expect(hasCloudPlatform(token.scopes)).toBe(true)
    expect(widerThanLevel(token.scopes)).toEqual([])
    expect(widerThanLevel([...token.scopes, "https://www.googleapis.com/auth/drive.readonly"])).toEqual(["https://www.googleapis.com/auth/drive.readonly"])
  })

  it("impersonates the configured service account with the bigquery scope, and names it as the identity", async () => {
    const client = new FakeClient({}, { scopes: [SCOPES.bigquery] })
    const fake = fakeLibrary(client, { type: "service_account", client_email: "source@invented.iam.gserviceaccount.com" })
    const token = await adcToken({ library: fake.library, now, impersonate: "target@invented.iam.gserviceaccount.com", scopes: [SCOPES.bigquery] })
    expect(fake.impersonated).toEqual([{ targetPrincipal: "target@invented.iam.gserviceaccount.com", targetScopes: [SCOPES.bigquery] }])
    expect(token).toMatchObject({ email: "target@invented.iam.gserviceaccount.com", verified: true })
  })

  it("maps a credential that cannot be found or minted to ADC_UNAVAILABLE", async () => {
    await expect(adcToken({ library: fakeLibrary(new Error("no default credentials"), {}).library, now })).rejects.toMatchObject({ code: "ADC_UNAVAILABLE" })
    await expect(adcToken({ library: fakeLibrary(new FakeClient({ token: null }), {}).library, now })).rejects.toMatchObject({ code: "ADC_UNAVAILABLE" })
  })

  it("recognises a managed host by the family's environment signal", () => {
    expect(isManagedHost({ OPENCODE_DISABLE_PROJECT_CONFIG: "1" })).toBe(true)
    expect(isManagedHost({ OPENCODE_CONFIG_PROJECT_DISABLE: "1" })).toBe(true)
    expect(isManagedHost({})).toBe(false)
  })
})

describe("ADC through the auth port", () => {
  const options = (allow: boolean) => loadOptions({ allowAdcInHost: allow, accounts: { ci: { mode: "adc", billingProject: "invented-proj" } } })

  it("refuses ADC in a managed host unless allowAdcInHost is set (ADC_REFUSED)", async () => {
    const env = { OPENCODE_DISABLE_PROJECT_CONFIG: "1" }
    const stateDir = mkdtempSync(join(tmpdir(), "bigquery-auth-adc-"))
    try {
      const auth = createAuthPort({ options: options(false), fetch: globalThis.fetch, now, env, stateDir, adc: async () => fakeLibrary(new FakeClient(), {}).library })
      await expect(auth.token("ci", signal)).rejects.toMatchObject({ code: "ADC_REFUSED" })
      expect(readdirSync(stateDir)).toEqual([])
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it("mints and caches one token, reports the identity, and stays read", async () => {
    const client = new FakeClient({ expires: now() + 1_800_000 }, { email: "ada@example.invalid", verified_email: true, scopes: [SCOPES.bigquery] })
    const fake = fakeLibrary(client, { type: "service_account", client_email: "invented@invented.iam.gserviceaccount.com" })
    const stateDir = mkdtempSync(join(tmpdir(), "bigquery-auth-adc-"))
    try {
      const auth = createAuthPort({ options: options(true), fetch: globalThis.fetch, now, stateDir, adc: async () => fake.library })
      const first = await auth.token("ci", signal)
      const second = await auth.token("ci", signal)
      expect(first.token).toBe(second.token)
      expect(client.calls.filter((call) => call === "getAccessToken")).toHaveLength(1)
      expect(await auth.identity("ci", signal)).toEqual({ email: "invented@invented.iam.gserviceaccount.com", verified: true })
      expect(await auth.level("ci", signal)).toMatchObject({ level: "read", refusal: "ACCOUNT_READ_ONLY" })
      expect(first.scopes).toEqual([SCOPES.bigquery])
      // A headless account writes no DPoP key.
      expect(readdirSync(stateDir)).toEqual([])
      expect(new FakeHost().reports).toEqual([])
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
