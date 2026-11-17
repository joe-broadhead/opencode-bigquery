// The one action table: names, actions, classes and owners, and what follows from it.
import { describe, expect, it } from "vitest"
import { ACTIONS, ASKS, CATEGORIES, COMMIT_TOOL, READ_ACTIONS, RPC_METHODS, TOOLS } from "../../src/domain/actions.js"
import { SCHEMAS } from "../../src/domain/contract.js"
import { CHANGE_HANDLERS } from "../../src/handlers/changes.js"
import { FILE_HANDLERS } from "../../src/handlers/files.js"
import { READ_HANDLERS } from "../../src/handlers/reads.js"
import { SOURCE_HANDLERS } from "../../src/handlers/sources.js"
import { STATUS_HANDLERS } from "../../src/handlers/status.js"

describe("the action table", () => {
  it("has the design's nineteen tools, twelve of them reads, and two method-only reads", () => {
    expect(TOOLS.map((entry) => entry.name)).toEqual([
      "status", "list", "table", "search", "estimate", "query", "job", "jobs", "profile", "plan", "events_list", "saved_read",
      "save", "cancel", "write", "export", "share", "delete", "admin",
    ])
    expect(TOOLS.filter((entry) => entry.readOnly)).toHaveLength(12)
    expect(ACTIONS.filter((entry) => entry.kind === "method").map((entry) => entry.name)).toEqual(["saved_list", "probe"])
    expect(READ_ACTIONS).toHaveLength(14)
  })

  it("names every action bigquery.<name>, once", () => {
    for (const entry of ACTIONS) expect(entry.action).toBe(`bigquery.${entry.name}`)
    expect(new Set(ACTIONS.map((entry) => entry.action)).size).toBe(ACTIONS.length)
    expect(ACTIONS.map((entry) => entry.action)).not.toContain(ASKS.uncappedRead)
  })

  it("marks a read read-only with the read class, and a change neither", () => {
    for (const entry of ACTIONS) expect(entry.readOnly, entry.name).toBe(entry.class === "read")
  })

  it("makes every read a tools RPC method, and no change", () => {
    expect(RPC_METHODS.map((entry) => entry.name).sort()).toEqual(READ_ACTIONS.map((entry) => entry.name).sort())
    expect(RPC_METHODS.every((entry) => entry.readOnly)).toBe(true)
  })

  it("routes every category to one tool, and each commit tool commits exactly its category", () => {
    for (const category of CATEGORIES.filter((item) => item !== "uncapped-read")) {
      const committers = ACTIONS.filter((entry) => entry.commits === category)
      expect(committers.map((entry) => `bigquery_${entry.name}`), category).toEqual([COMMIT_TOOL[category]])
    }
    expect(COMMIT_TOOL["uncapped-read"]).toBe("bigquery_query")
  })

  it("offers no Always for delete, and Always for every other change", () => {
    for (const entry of ACTIONS.filter((item) => !item.readOnly)) expect(entry.savable, entry.name).toBe(entry.name !== "delete")
  })

  it("lets only plan resolve a change's operation", () => {
    expect(ACTIONS.filter((entry) => entry.resourceKind === "any").map((entry) => entry.name)).toEqual(["plan"])
  })

  it("has a schema for every entry, and nothing else", () => {
    expect(Object.keys(SCHEMAS).sort()).toEqual(ACTIONS.map((entry) => entry.name).sort())
  })

  it("keeps Jelly's notes to 200 characters", () => {
    for (const entry of ACTIONS) expect((entry.note ?? "").length, entry.name).toBeLessThanOrEqual(200)
  })

  it("has each handler built by the package that owns its entry, in that package's file only", () => {
    const files = { F: STATUS_HANDLERS, C: READ_HANDLERS, D: CHANGE_HANDLERS, E: { ...FILE_HANDLERS, ...SOURCE_HANDLERS } } as Record<string, object>
    const seen = new Map<string, string>()
    for (const [owner, handlers] of Object.entries(files)) {
      for (const name of Object.keys(handlers)) {
        expect(seen.has(name), name).toBe(false)
        seen.set(name, owner)
        expect(ACTIONS.find((entry) => entry.name === name)?.owner, name).toBe(owner)
      }
    }
  })
})
