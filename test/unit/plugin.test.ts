// The registrations' transforms never throw: a failure is reported for status instead.
import { describe, expect, it } from "vitest"
import { NAMESPACE } from "../../src/constants.js"
import { registerTools } from "../../src/tools.js"

describe("the tools transform", () => {
  it("names the namespace and adds each spec", async () => {
    const calls: unknown[] = []
    const ctx = {
      tool: {
        transform: async (callback: (editor: unknown) => void) => {
          callback({ namespace: (input: unknown) => calls.push(["namespace", input]), add: (tool: unknown) => calls.push(["add", tool]) })
          return { dispose: async () => undefined }
        },
      },
    }
    const reports: (string | undefined)[] = []
    await registerTools(ctx as never, { access: "all", specs: [], assert: async () => undefined, report: (problem) => reports.push(problem) })
    expect(calls).toEqual([["namespace", { name: NAMESPACE, description: expect.stringContaining("BigQuery") }]])
    expect(reports).toEqual([undefined])
  })

  it("never throws from the transform; a failure is reported", async () => {
    const ctx = { tool: { transform: async (callback: (editor: unknown) => void) => (callback({ namespace: () => { throw new Error("broken host") } }), { dispose: async () => undefined }) } }
    const reports: (string | undefined)[] = []
    await registerTools(ctx as never, { access: "all", specs: [], assert: async () => undefined, report: (problem) => reports.push(problem) })
    expect(reports[0]).toMatch(/^TOOLS_NOT_REGISTERED: .* Next step: Restart OpenCode\.$/)
  })
})
