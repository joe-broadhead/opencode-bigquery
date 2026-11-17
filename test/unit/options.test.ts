import { describe, expect, it } from "vitest"
import { loadOptions } from "../../src/options.js"

describe("options", () => {
  it("defaults: access all, and no untested hosts", () => {
    expect(loadOptions(undefined)).toMatchObject({ access: "all", allowUntestedHost: false })
    expect(loadOptions({})).toEqual(loadOptions(undefined))
  })

  it("refuses an unknown option with OPTIONS_INVALID, naming it", () => {
    expect(() => loadOptions({ acess: "all" })).toThrow(/^OPTIONS_INVALID: Invalid plugin option "acess": this option does not exist\. Next step: /)
  })

  it("refuses a wrong value with OPTIONS_INVALID", () => {
    expect(() => loadOptions({ access: "read" })).toThrow(/OPTIONS_INVALID/)
    expect(() => loadOptions({ allowUntestedHost: "yes" })).toThrow(/OPTIONS_INVALID/)
    expect(() => loadOptions([])).toThrow(/OPTIONS_INVALID/)
  })
})
