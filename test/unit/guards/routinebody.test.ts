// The statement whose dry run names what a SQL routine's body reads (src/guards/routinebody.ts): arguments become typed
// NULLs from Google's StandardSqlDataType, a scalar body is wrapped in SELECT ( … ), and anything that cannot be built
// is undefined, which expansion turns into UNRESOLVED_REFERENCE.
import { describe, expect, it } from "vitest"
import type { RoutineInfo } from "../../../src/domain/google.js"
import { createLexer } from "../../../src/guards/lexer.js"
import { routineProbeSql, sqlTypeOf } from "../../../src/guards/routinebody.js"
import { routine } from "../reads/support.js"

const lexer = createLexer()
const probe = (overrides: Partial<RoutineInfo>) => routineProbeSql(routine(overrides), lexer)
const int64 = { typeKind: "INT64" }

describe("Google's StandardSqlDataType as GoogleSQL", () => {
  it("writes scalars, arrays, ranges and structs, escaping field names", () => {
    expect(sqlTypeOf(int64)).toBe("INT64")
    expect(sqlTypeOf({ typeKind: "ARRAY", arrayElementType: { typeKind: "STRING" } })).toBe("ARRAY<STRING>")
    expect(sqlTypeOf({ typeKind: "RANGE", rangeElementType: { typeKind: "DATE" } })).toBe("RANGE<DATE>")
    expect(sqlTypeOf({ typeKind: "STRUCT", structType: { fields: [{ name: "x", type: { typeKind: "STRING" } }, { name: "we`ird", type: int64 }] } })).toBe("STRUCT<`x` STRING, `we\\`ird` INT64>")
  })

  it("is undefined for anything it does not know, so nothing unknown is written into SQL", () => {
    for (const type of [undefined, null, {}, { typeKind: "TYPE_KIND_UNSPECIFIED" }, { typeKind: "INT64); DROP TABLE x; --" }, { typeKind: "ARRAY" }, { typeKind: "STRUCT", structType: { fields: [] } }]) {
      expect(sqlTypeOf(type), JSON.stringify(type)).toBeUndefined()
    }
  })
})

describe("a routine body as a dry-runnable statement", () => {
  it("wraps a scalar function's expression and stands typed NULLs in for its arguments", () => {
    expect(probe({ definitionBody: "x + 1", arguments: [{ name: "x", dataType: int64 }] })).toBe("SELECT (\n(CAST(NULL AS INT64)) + 1\n)")
  })

  it("keeps a table function's query as it is, with its scalar arguments replaced", () => {
    expect(probe({ routineType: "TABLE_VALUED_FUNCTION", definitionBody: "SELECT * FROM ds.a, fenced.secret WHERE id = n", arguments: [{ name: "n", dataType: int64 }] })).toBe(
      "SELECT * FROM ds.a, fenced.secret WHERE id = (CAST(NULL AS INT64))",
    )
  })

  it("stands a bare NULL in for an ANY TYPE argument, and matches names case-insensitively and backquoted", () => {
    expect(probe({ definitionBody: "UPPER(`X`) || x", arguments: [{ name: "x", argumentKind: "ANY_TYPE" } as never] })).toBe("SELECT (\nUPPER((NULL)) || (NULL)\n)")
  })

  it("leaves a field of something else, a call of the same name, and strings and comments alone", () => {
    expect(probe({ definitionBody: "t.x + x(1) + 'x' -- x\n", arguments: [{ name: "x", dataType: int64 }] })).toBe("SELECT (\nt.x + x(1) + 'x' -- x\n\n)")
  })

  it("puts the closing parenthesis on its own line, so a trailing comment cannot swallow it", () => {
    expect(probe({ definitionBody: "1 -- one" })).toBe("SELECT (\n1 -- one\n)")
  })

  it("replaces an argument on a later line at the right place", () => {
    expect(probe({ definitionBody: "(SELECT COUNT(*)\n  FROM ds.t\n  WHERE k = key)", arguments: [{ name: "key", dataType: { typeKind: "STRING" } }] })).toBe(
      "SELECT (\n(SELECT COUNT(*)\n  FROM ds.t\n  WHERE k = (CAST(NULL AS STRING)))\n)",
    )
  })

  it("is undefined for a procedure, an unknown routine type, a table argument, an empty body and a body that does not lex", () => {
    expect(probe({ routineType: "PROCEDURE", definitionBody: "SELECT 1" })).toBeUndefined()
    expect(probe({ routineType: undefined, definitionBody: "1" })).toBeUndefined()
    expect(probe({ routineType: "TABLE_VALUED_FUNCTION", definitionBody: "SELECT * FROM t", arguments: [{ name: "t", argumentKind: "ANY_TABLE" } as never] })).toBeUndefined()
    expect(probe({ definitionBody: "  " })).toBeUndefined()
    expect(probe({ definitionBody: "'unterminated" })).toBeUndefined()
  })
})
