// The write level is Google's grant: the sign-in record and the scopes of this process's last refresh (design §3.1).
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { WRITE_LEVEL_AVAILABLE } from "../../src/constants.js"
import { BigQueryError } from "../../src/domain/errors.js"
import { ALL_SCOPES, authorizationParams, decideLevel, DISCLOSURE, FORBIDDEN_AUTHORIZATION_PARAMS, requireWrite, SCOPES, scopesFor, SignInRecordSchema } from "../../src/domain/levels.js"
import { loadOptions, OptionsSchema } from "../../src/options.js"
import { FakeAuth, readRecord, writeRecord } from "../fake/ports.js"

const signal = new AbortController().signal
const WITH_MARKER = [SCOPES.openid, SCOPES.email, SCOPES.bigquery, SCOPES.writeMarker]
const WITHOUT_MARKER = [SCOPES.openid, SCOPES.email, SCOPES.bigquery]

describe("the sign-in request", () => {
  it("asks Read for three scopes and Read and write for the marker too", () => {
    expect(scopesFor("read")).toEqual(WITHOUT_MARKER)
    expect(scopesFor("write")).toEqual(WITH_MARKER)
    expect(ALL_SCOPES).toEqual([...WITH_MARKER].sort())
  })

  it("sends prompt=consent at both levels, and never include_granted_scopes", () => {
    for (const level of ["read", "write"] as const) {
      const params = authorizationParams(level)
      expect(params.prompt).toBe("consent")
      for (const forbidden of FORBIDDEN_AUTHORIZATION_PARAMS) expect(params).not.toHaveProperty(forbidden)
      expect(params.scope.split(" ").includes(SCOPES.writeMarker)).toBe(level === "write")
    }
  })
})

describe("the level", () => {
  const write = writeRecord()

  it("is write only on both checks: a write record and the marker in this process's refresh", () => {
    expect(decideLevel({ mode: "interactive", record: write, refreshedScopes: WITH_MARKER, writeAvailable: true })).toEqual({ level: "write" })
  })

  it("is read for a Read sign-in, whatever the refresh returns (the reverse case)", () => {
    expect(decideLevel({ mode: "interactive", record: readRecord(), refreshedScopes: WITH_MARKER, writeAvailable: true })).toMatchObject({ level: "read", refusal: "ACCOUNT_READ_ONLY" })
  })

  it("refuses an edited record whose refresh lacks the marker: WRITE_LEVEL_UNVERIFIED", () => {
    expect(decideLevel({ mode: "interactive", record: write, refreshedScopes: WITHOUT_MARKER, writeAvailable: true })).toMatchObject({ refusal: "WRITE_LEVEL_UNVERIFIED" })
    expect(decideLevel({ mode: "interactive", record: write, writeAvailable: true })).toMatchObject({ refusal: "WRITE_LEVEL_UNVERIFIED" })
  })

  it("never reads a scope string stored with the record: it is not an input", () => {
    // The record schema is strict: a stored scope string cannot even be part of it.
    expect(SignInRecordSchema.safeParse({ ...write, scope: WITH_MARKER.join(" ") }).success).toBe(false)
  })

  it("lets the level option lower write to read, never raise read to write", () => {
    expect(decideLevel({ mode: "interactive", record: write, refreshedScopes: WITH_MARKER, configured: "read", writeAvailable: true })).toMatchObject({ level: "read" })
    expect(decideLevel({ mode: "interactive", record: readRecord(), refreshedScopes: WITH_MARKER, configured: "write", writeAvailable: true })).toMatchObject({ level: "read" })
  })

  it("keeps headless modes read, and refuses a write level on them at option parse", () => {
    for (const mode of ["adc", "token"] as const) {
      expect(decideLevel({ mode, record: write, refreshedScopes: WITH_MARKER, writeAvailable: true })).toMatchObject({ refusal: "ACCOUNT_READ_ONLY" })
    }
    expect(() => loadOptions({ accounts: { ci: { mode: "adc", level: "write" } } })).toThrow(/^OPTIONS_INVALID: Invalid plugin option "accounts\.ci\.level"/)
    expect(() => loadOptions({ accounts: { ci: { mode: "token", tokenEnv: "BQ_TOKEN", level: "write" } } })).toThrow(/OPTIONS_INVALID/)
  })

  it("is off when the release ships without the write level", () => {
    expect(decideLevel({ mode: "interactive", record: write, refreshedScopes: WITH_MARKER, writeAvailable: false })).toMatchObject({ refusal: "WRITE_LEVEL_UNAVAILABLE" })
  })

  it("refuses a commit with the decision's code before anything is sent", () => {
    expect(() => requireWrite({ level: "write" }, "work")).not.toThrow()
    const decision = decideLevel({ mode: "interactive", record: readRecord(), writeAvailable: true })
    expect(() => requireWrite(decision, "work")).toThrow(BigQueryError)
    expect(() => requireWrite(decision, "work")).toThrow(/^ACCOUNT_READ_ONLY: /)
  })

  it("through the fake auth port: refreshes once per process for a write record, and follows Google's answer", async () => {
    const auth = new FakeAuth({ work: { mode: "interactive", record: write, refreshScopes: WITH_MARKER } })
    expect(await auth.level("work", signal)).toEqual({ level: "write" })
    expect(auth.refreshes.get("work")).toBe(1)
    // Google stops returning the marker (a later Read sign-in elsewhere): this process still holds its answer...
    auth.accountsByAlias.work!.refreshScopes = WITHOUT_MARKER
    expect(await auth.level("work", signal)).toEqual({ level: "write" })
    // ...and a new process refreshes first, and refuses.
    auth.restart()
    expect(await auth.level("work", signal)).toMatchObject({ refusal: "WRITE_LEVEL_UNVERIFIED" })
  })
})

describe("a token account", () => {
  it("has empty scopes (unknown, not missing), and stays read", async () => {
    const auth = new FakeAuth({ ci: { mode: "token", record: writeRecord(), refreshScopes: WITH_MARKER } })
    expect((await auth.token("ci", signal)).scopes).toEqual([])
    expect(auth.refreshes.get("ci")).toBeUndefined()
    expect(await auth.level("ci", signal)).toMatchObject({ level: "read", refusal: "ACCOUNT_READ_ONLY" })
  })
})

describe("the disclosure", () => {
  it("has a bound and an unbound wording, the unbound one without the key file", () => {
    expect(DISCLOSURE.bound).toContain("this plugin's key file")
    expect(DISCLOSURE.unbound).not.toContain("key file")
    expect(DISCLOSURE.bound.endsWith("Job User and Data Viewer.")).toBe(true)
  })
})

describe("the write level's availability (bigquery-1 LOW 2)", () => {
  const SRC = fileURLToPath(new URL("../../src", import.meta.url))
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []))

  it("is a build constant, true in this build", () => {
    expect(WRITE_LEVEL_AVAILABLE).toBe(true)
  })

  it("is no option: none is named for it, and one is refused", () => {
    const keys = Object.keys(OptionsSchema.shape)
    expect(keys.filter((key) => /write|available/i.test(key))).toEqual([])
    for (const key of ["writeAvailable", "writeLevelAvailable", "WRITE_LEVEL_AVAILABLE"]) expect(() => loadOptions({ [key]: true })).toThrow(/^OPTIONS_INVALID: /)
    expect(() => loadOptions({ accounts: { work: { writeAvailable: true } } })).toThrow(/^OPTIONS_INVALID: /)
  })

  it("reaches decideLevel only from the constant: no source sets writeAvailable from anything else", () => {
    const settings = walk(SRC).flatMap((file) => [...readFileSync(file, "utf8").matchAll(/writeAvailable\s*:\s*([^,}\n]+)/g)].map((match) => `${file.slice(SRC.length)}: ${match[1]!.trim()}`))
    expect(settings.filter((line) => !/: (boolean|WRITE_LEVEL_AVAILABLE)$/.test(line))).toEqual([])
  })
})
