// Every statement type Google's enum lists has a kind, and the lexer can only raise one.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { kindOf, raise, STATEMENT_KINDS, STATEMENT_TYPES, STRICTNESS, stricter } from "../../src/domain/statements.js"

const fixture = JSON.parse(readFileSync(new URL("../fixtures/statement-types.json", import.meta.url), "utf8")) as { source: string; values: string[] }

describe("statement types", () => {
  it("map exactly the values of Google's enum, read from the Job resource", () => {
    expect(fixture.source).toBe("https://cloud.google.com/bigquery/docs/reference/rest/v2/Job")
    expect(fixture.values.filter((value) => kindOf(value) === undefined)).toEqual([])
    expect(STATEMENT_TYPES.filter((value) => !fixture.values.includes(value))).toEqual([])
    expect(STATEMENT_TYPES).toHaveLength(79)
  })

  it("leave an unknown type unclassified, so it is refused", () => {
    expect(kindOf("CREATE_TELEPORTER")).toBeUndefined()
    expect(kindOf("select")).toBeUndefined()
  })

  it("read only SELECT and ASSERT", () => {
    expect(STATEMENT_TYPES.filter((type) => STATEMENT_KINDS[type] === "read").sort()).toEqual(["ASSERT", "SELECT"])
  })

  it("follow design §5.2 for the hard cases", () => {
    expect(kindOf("MERGE")).toBe("write")
    expect(kindOf("LOAD_DATA")).toBe("write")
    expect(kindOf("UNDROP_SCHEMA")).toBe("write")
    expect(kindOf("SCRIPT")).toBe("delete")
    expect(kindOf("CALL")).toBe("delete")
    expect(kindOf("BEGIN_TRANSACTION")).toBe("delete")
    expect(kindOf("TRUNCATE_TABLE")).toBe("delete")
    expect(kindOf("CREATE_ROW_ACCESS_POLICY")).toBe("share")
    expect(kindOf("DROP_ROW_ACCESS_POLICY")).toBe("share")
    expect(kindOf("ALTER_DATA_POLICY")).toBe("share")
    expect(kindOf("DROP_RESERVATION")).toBe("admin")
    expect(kindOf("ALTER_BI_CAPACITY")).toBe("admin")
    expect(kindOf("CREATE_CONNECTION")).toBe("admin")
    expect(kindOf("EXPORT_METADATA")).toBe("export")
    expect(kindOf("GRANT_ON_PROJECT")).toBe("share")
  })

  it("a lexer finding never lowers a decision (every pair)", () => {
    for (const table of STRICTNESS) {
      expect(raise(table, undefined)).toBe(table)
      for (const finding of STRICTNESS) {
        const raised = raise(table, finding)
        expect(STRICTNESS.indexOf(raised)).toBeGreaterThanOrEqual(STRICTNESS.indexOf(table))
        expect(raised).toBe(stricter(finding, table))
      }
    }
  })
})
