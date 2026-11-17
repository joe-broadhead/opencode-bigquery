import { describe, expect, it } from "vitest"
import { accountsOf, loadOptions, parseBytes } from "../../src/options.js"

const GiB = 2 ** 30

describe("options", () => {
  it("defaults to the design's values (§12)", () => {
    expect(loadOptions(undefined)).toEqual({
      access: "all",
      allowAdcInHost: false,
      maxBytesBilled: 10 * GiB,
      maxBytesCeiling: 100 * GiB,
      onDemandUsdPerTiB: 6.25,
      maxRows: 50,
      maxInlineBytes: 32 * 1024,
      maxSaveRows: 1_000_000,
      maxSaveBytes: 256 * 2 ** 20,
      resultsDir: ".bigquery/results",
      allowedRoots: [],
      jobTimeoutSeconds: 600,
      uncappedTimeoutSeconds: 120,
      maxConcurrentJobs: 4,
      scripts: true,
      uncappedReads: "ask",
      policyTagged: "withhold",
      savedQueries: {},
      planTtlSeconds: 300,
      admin: { enabled: true, requireReason: true },
      allowUntestedHost: false,
    })
    expect(loadOptions({})).toEqual(loadOptions(undefined))
  })

  it("has one default interactive account when none is configured", () => {
    expect(accountsOf(loadOptions({}))).toEqual({ default: { mode: "interactive" } })
    expect(Object.keys(accountsOf(loadOptions({ accounts: { work: {}, ci: { mode: "adc" } } })))).toEqual(["work", "ci"])
  })

  it("reads byte sizes", () => {
    expect(parseBytes("10GiB")).toBe(10 * GiB)
    expect(parseBytes("512 MiB")).toBe(512 * 2 ** 20)
    expect(parseBytes(1000)).toBe(1000)
    expect(loadOptions({ maxBytesBilled: "1GiB" }).maxBytesBilled).toBe(GiB)
    expect(() => loadOptions({ maxBytesBilled: "lots" })).toThrow(/OPTIONS_INVALID/)
    expect(() => loadOptions({ maxBytesBilled: "200GiB" })).toThrow(/maxBytesBilled/)
  })

  it("caps maxInlineBytes at 256 KiB (design §7)", () => {
    expect(loadOptions({ maxInlineBytes: "256KiB" }).maxInlineBytes).toBe(256 * 1024)
    expect(() => loadOptions({ maxInlineBytes: 256 * 1024 + 1 })).toThrow(/^OPTIONS_INVALID: Invalid plugin option "maxInlineBytes": at most 256 KiB/)
  })

  it("refuses an unknown option with OPTIONS_INVALID, naming it, nested ones too", () => {
    expect(() => loadOptions({ acess: "all" })).toThrow(/^OPTIONS_INVALID: Invalid plugin option "acess": this option does not exist\. Next step: /)
    expect(() => loadOptions({ accounts: { work: { levle: "read" } } })).toThrow(/"accounts\.work\.levle": this option does not exist/)
  })

  it("refuses a wrong value, and options that do not fit together", () => {
    expect(() => loadOptions({ access: "read" })).toThrow(/OPTIONS_INVALID/)
    expect(() => loadOptions({ allowUntestedHost: "yes" })).toThrow(/OPTIONS_INVALID/)
    expect(() => loadOptions([])).toThrow(/OPTIONS_INVALID/)
    expect(() => loadOptions({ accounts: { Work: {} } })).toThrow(/OPTIONS_INVALID/)
    expect(() => loadOptions({ accounts: { ci: { mode: "token" } } })).toThrow(/tokenEnv/)
    expect(() => loadOptions({ accounts: { work: { impersonate: "x@p.iam.gserviceaccount.com" } } })).toThrow(/impersonate/)
    expect(() => loadOptions({ redirectUri: "https://host.example/return" })).toThrow(/callbackPort/)
    expect(() => loadOptions({ uncappedReads: "allow" })).toThrow(/OPTIONS_INVALID/)
  })
})
