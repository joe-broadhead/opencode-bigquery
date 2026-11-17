// The contract's schemas: each converts to JSON Schema for describe and Code Mode, each output takes the refusal
// envelope, and the inputs refuse what the design rules out.
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { PlanInput, ProfileInput, QueryInput, SCHEMAS } from "../../src/domain/contract.js"
import { ERROR_CODES, ErrorCode } from "../../src/domain/errors.js"

const PLAN_ID = "plan_inventedinventedinvented1"

describe("the contract's schemas", () => {
  it("each convert to JSON Schema, inputs and outputs", () => {
    for (const [name, schemas] of Object.entries(SCHEMAS)) {
      expect(() => z.toJSONSchema(schemas.input, { io: "input", unrepresentable: "any" }), name).not.toThrow()
      expect(() => z.toJSONSchema(schemas.output, { io: "output", unrepresentable: "any" }), name).not.toThrow()
    }
  })

  it("each output takes a refusal envelope with Google's text apart, for every code", () => {
    for (const [name, schemas] of Object.entries(SCHEMAS)) {
      for (const code of ERROR_CODES) {
        const state = ErrorCode[code].state === "setup" ? "refused" : ErrorCode[code].state
        const refusal = { state, error: code, message: "What happened.", next: "What to do.", googleError: { reason: "invalidQuery", message: "text", trust: "untrusted" } }
        expect(schemas.output.safeParse(refusal).success, `${name} ${code}`).toBe(true)
      }
      expect(schemas.output.safeParse({ state: "done" }).success, name).toBe(true)
    }
  })

  it("query takes sql, or a planId alone", () => {
    expect(QueryInput.safeParse({ sql: "SELECT 1" }).success).toBe(true)
    expect(QueryInput.safeParse({ planId: PLAN_ID }).success).toBe(true)
    expect(QueryInput.safeParse({ planId: PLAN_ID, account: "work" }).success).toBe(true)
    expect(QueryInput.safeParse({}).success).toBe(false)
    expect(QueryInput.safeParse({ sql: "SELECT 1", planId: PLAN_ID }).success).toBe(false)
    expect(QueryInput.safeParse({ planId: PLAN_ID, maxBytes: 10 }).success).toBe(false)
    expect(QueryInput.safeParse({ sql: "SELECT 1", maxRows: 501 }).success).toBe(false)
    expect(QueryInput.safeParse({ sql: "SELECT 1", destination: "p.d.t" }).success).toBe(false)
  })

  it("refuses text over 1 MiB, and keys the design does not name", () => {
    expect(PlanInput.safeParse({ sql: "x".repeat(1_048_577) }).success).toBe(false)
    expect(PlanInput.safeParse({ sql: "DELETE FROM t WHERE TRUE", useLegacySql: true }).success).toBe(false)
    expect(ProfileInput.safeParse({ table: "p.d.t", sql: "SELECT 1" }).success).toBe(false)
  })

  it("commit tools take the planId alone", () => {
    for (const name of ["write", "export", "share", "delete", "admin"] as const) {
      expect(SCHEMAS[name].input.safeParse({ planId: PLAN_ID }).success).toBe(true)
      expect(SCHEMAS[name].input.safeParse({ planId: PLAN_ID, sql: "DROP TABLE t" }).success).toBe(false)
    }
  })
})
