// Design §14.1 "Lexer fuzz": the tokenizer and the findings that make a statement stricter. Comments, every string
// form, backquoted paths and parameters; `SAFE.AI.GENERATE`, `ml /* x */ . generate_text`, `EXTERNAL_QUERY` in any
// case, `OBJ.GET_ACCESS_URL`; unterminated tokens; M4's destructive wording; and the property that the lexer never
// lowers a decision.
import { describe, expect, it } from "vitest"
import { createLexer, lexText, significantTokens } from "../../../src/guards/lexer.js"
import { kindOf, raise, STATEMENT_KINDS, type StatementType } from "../../../src/domain/statements.js"

const lexer = createLexer()
const lex = (sql: string) => {
  const result = lexer.lex(sql)
  if (!result.ok) throw new Error(`expected ${sql} to lex, got ${result.error.what}`)
  return result.tokens
}
const found = (sql: string) => lexer.findings(lex(sql))
const kinds = (sql: string) => lex(sql).map((token) => token.kind)

describe("the lexer", () => {
  it("reads keywords case-insensitively and keeps identifiers apart", () => {
    const tokens = lex("SeLeCt a, From_x FROM t")
    expect(tokens.map((token) => [token.kind, token.value])).toEqual([
      ["keyword", "SELECT"],
      ["identifier", "A"],
      ["punctuation", ","],
      ["identifier", "FROM_X"],
      ["keyword", "FROM"],
      ["identifier", "T"],
    ])
  })

  it("reads every string form, and no comment marker inside one starts a comment", () => {
    expect(kinds("SELECT 'a -- b', \"c # d\", '''e /* f */''', r'a\\b', b'by', rb'raw bytes'")).toEqual([
      "keyword",
      "string",
      "punctuation",
      "string",
      "punctuation",
      "string",
      "punctuation",
      "string",
      "punctuation",
      "string",
      "punctuation",
      "string",
    ])
  })

  it("keeps comments as tokens, in all three forms, with their line and column", () => {
    const tokens = lex("SELECT 1 -- one\n# two\n/* three */ + 2")
    expect(tokens.filter((token) => token.kind === "comment").map((token) => token.text)).toEqual(["-- one", "# two", "/* three */"])
    expect(tokens.find((token) => token.text === "# two")).toMatchObject({ line: 2, column: 1 })
    expect(significantTokens(tokens).map((token) => token.text)).toEqual(["SELECT", "1", "+", "2"])
  })

  it("splits a backquoted path on dots, with escapes, and reads parameters", () => {
    expect(lex("`invented-proj.sales.orders`")[0]).toMatchObject({ kind: "quoted", parts: ["invented-proj", "sales", "orders"], value: "invented-proj.sales.orders" })
    expect(lex("`a`.`b`")[0]).toMatchObject({ parts: ["a"] })
    expect(lex("`a.b`")[0]).toMatchObject({ parts: ["a", "b"] })
    expect(lex("`we\\`ird`")[0]!.parts).toEqual(["we`ird"])
    expect(kinds("SELECT @name, @@project, ?")).toEqual(["keyword", "parameter", "punctuation", "parameter", "punctuation", "parameter"])
  })

  it("reads numbers, including decimals, exponents and hex", () => {
    expect(kinds("1 1.5 1e9 1.5E-3 0xFF")).toEqual(["number", "number", "number", "number", "number"])
  })

  it("refuses unterminated strings, comments and backquotes, with their position", () => {
    for (const [sql, what] of [
      ["SELECT 'abc", "unterminated-string"],
      ["SELECT '''abc\n", "unterminated-string"],
      ["SELECT /* abc", "unterminated-comment"],
      ["SELECT `abc", "unterminated-identifier"],
      ["SELECT r'abc", "unterminated-string"],
    ] as const) {
      const result = lexText(sql)
      expect(result.ok, sql).toBe(false)
      if (!result.ok) expect(result.error).toMatchObject({ what, line: 1, column: sql.startsWith("SELECT '") || sql.startsWith("SELECT r'") ? 8 : 8 })
    }
  })

  it("reports a character GoogleSQL has no token for", () => {
    expect(lexText("SELECT \u0000")).toMatchObject({ ok: false, error: { what: "invalid-character", line: 1, column: 8 } })
  })

  it("reads the dialect hints", () => {
    expect(found("SELECT 1").dialectHint).toBeUndefined()
    expect(found("#legacySQL\nSELECT 1").dialectHint).toBe("legacy")
    expect(found("#standardSQL\nSELECT 1").dialectHint).toBe("standard")
    // Both: the stricter one, because the read path refuses legacy SQL.
    expect(found("#standardSQL\n#legacySQL\nSELECT 1").dialectHint).toBe("legacy")
  })
})

describe("the lexer's external effects", () => {
  it("finds EXTERNAL_QUERY in any case, quoted or not", () => {
    expect(found("SELECT * FROM EXTERNAL_QUERY('conn', 'select 1')").externalEffects).toEqual(["EXTERNAL_QUERY"])
    expect(found("select * from external_query('conn', 'select 1')").externalEffects).toEqual(["EXTERNAL_QUERY"])
    expect(found("SELECT * FROM `external_query`('conn', 'x')").externalEffects).toEqual(["EXTERNAL_QUERY"])
    // Whitespace and comments between the name and the call.
    expect(found("SELECT * FROM EXTERNAL_QUERY /* x */ ('conn', 'x')").externalEffects).toEqual(["EXTERNAL_QUERY"])
  })

  it("finds every ML and AI call, plain, backquoted and SAFE-prefixed, with anything between the parts", () => {
    expect(found("SELECT ML.GENERATE_TEXT(MODEL `p.m`, TABLE t, STRUCT(0.2 AS temperature))").externalEffects).toEqual(["ML.GENERATE_TEXT"])
    expect(found("SELECT `ml`.`generate_text`(MODEL `p.m`, TABLE t)").externalEffects).toEqual(["ML.GENERATE_TEXT"])
    expect(found("SELECT ml /*x*/ . generate_text(MODEL `p.m`)").externalEffects).toEqual(["ML.GENERATE_TEXT"])
    expect(found("SELECT `ml` . `generate_text`(MODEL `p.m`)").externalEffects).toEqual(["ML.GENERATE_TEXT"])
    expect(found("SELECT SAFE.AI.GENERATE(1)").externalEffects).toEqual(["SAFE.AI.GENERATE"])
    expect(found("SELECT SAFE.`AI`.GENERATE(1)").externalEffects).toEqual(["SAFE.AI.GENERATE"])
    expect(found("SELECT AI.GENERATE_TABLE(MODEL `p.m`, TABLE t)").externalEffects).toEqual(["AI.GENERATE_TABLE"])
    expect(found("SELECT SAFE.ML.PREDICT(MODEL `p.m`, TABLE t)").externalEffects).toEqual(["SAFE.ML.PREDICT"])
  })

  it("finds OBJ.GET_ACCESS_URL, which returns read and write URLs", () => {
    expect(found("SELECT OBJ.GET_ACCESS_URL(ref, 'r')").externalEffects).toEqual(["OBJ.GET_ACCESS_URL"])
    expect(found("SELECT `OBJ`.`GET_ACCESS_URL`(ref, 'w')").externalEffects).toEqual(["OBJ.GET_ACCESS_URL"])
    expect(found("SELECT obj /*x*/ . get_access_url(ref, 'w')").externalEffects).toEqual(["OBJ.GET_ACCESS_URL"])
  })

  it("does not mistake a dataset called ml, or a mention in a string or comment, for an effect", () => {
    expect(found("SELECT * FROM ml.models").externalEffects).toEqual([])
    expect(found("SELECT 'ML.GENERATE_TEXT(x)'").externalEffects).toEqual([])
    expect(found("-- ML.GENERATE_TEXT(x)\nSELECT 1").externalEffects).toEqual([])
    expect(found("/* EXTERNAL_QUERY('a','b') */ SELECT 1").externalEffects).toEqual([])
    expect(found("SELECT `ml`.`generate_text`").externalEffects).toEqual([])
  })

  it("raises an external effect to write, and to nothing stronger than a read's own table kind", () => {
    expect(found("SELECT ML.GENERATE_TEXT(MODEL `p.m`, TABLE t)").raisesTo).toBe("write")
    expect(raise("read", found("SELECT OBJ.GET_ACCESS_URL(r, 'w')").raisesTo)).toBe("write")
    // Never lower: a delete statement that also calls a function stays delete.
    expect(raise("delete", found("SELECT ML.GENERATE_TEXT(MODEL `p.m`)").raisesTo)).toBe("delete")
  })
})

describe("the lexer's destructive wording (review M4)", () => {
  const raises = (sql: string) => found(sql).raisesTo

  it("raises DELETE in MERGE, and nothing else, to delete", () => {
    expect(raises("MERGE t USING s ON t.id = s.id WHEN MATCHED THEN DELETE")).toBe("delete")
    expect(raises("MERGE t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET x = 1")).toBeUndefined()
  })

  it("raises DROP in ALTER to delete, and a bare DROP stays the statement table's", () => {
    expect(raises("ALTER TABLE t DROP COLUMN c")).toBe("delete")
    expect(raises("ALTER TABLE t ADD COLUMN c INT64")).toBeUndefined()
  })

  it("raises OR REPLACE to delete", () => {
    expect(raises("CREATE OR REPLACE TABLE t AS SELECT 1")).toBe("delete")
    expect(raises("CREATE TABLE t AS SELECT 1")).toBeUndefined()
  })

  it("raises each expiry option in SET OPTIONS to delete, and a create-time option not at all", () => {
    for (const option of ["expiration_timestamp", "partition_expiration_days", "default_table_expiration_days", "default_partition_expiration_days"]) {
      expect(raises(`ALTER TABLE t SET OPTIONS (${option} = 1)`, ), option).toBe("delete")
    }
    expect(raises("CREATE TABLE t (x INT64) OPTIONS (expiration_timestamp = TIMESTAMP '2030-01-01')")).toBeUndefined()
    expect(raises("ALTER TABLE t SET OPTIONS (description = 'x')")).toBeUndefined()
  })

  it("raises LOAD DATA OVERWRITE to delete, and an append not at all", () => {
    expect(raises("LOAD DATA OVERWRITE t FROM FILES (format = 'CSV', uris = ['gs://b/x'])")).toBe("delete")
    expect(raises("LOAD DATA INTO t FROM FILES (format = 'CSV', uris = ['gs://b/x'])")).toBeUndefined()
  })

  it("raises CALL, EXECUTE IMMEDIATE and transactions to delete, but not inside a routine's body", () => {
    expect(raises("CALL `p.ds`.do_things()")).toBe("delete")
    expect(raises("EXECUTE IMMEDIATE 'DROP TABLE t'")).toBe("delete")
    expect(raises("BEGIN TRANSACTION")).toBe("delete")
    expect(raises("COMMIT TRANSACTION")).toBe("delete")
    expect(raises("ROLLBACK TRANSACTION")).toBe("delete")
    // The body is stored, not run: creating a procedure that calls something is a write, not a delete.
    expect(raises("CREATE PROCEDURE p() BEGIN CALL q(); EXECUTE IMMEDIATE 'select 1'; END")).toBeUndefined()
    expect(raises("CREATE TABLE FUNCTION f() AS (SELECT 1)")).toBeUndefined()
  })

  it("keeps the strictest finding", () => {
    expect(raises("CREATE OR REPLACE TABLE t AS SELECT ML.GENERATE_TEXT(MODEL `p.m`)")).toBe("delete")
    expect(raise("delete", raises("EXECUTE IMMEDIATE 'x'"))).toBe("delete")
    expect(raise("admin", "delete")).toBe("admin")
  })

  it("is not fooled by comments or strings that carry the words", () => {
    expect(raises("SELECT 1 -- DELETE FROM t")).toBeUndefined()
    expect(raises("/* MERGE … DELETE */ SELECT 1")).toBeUndefined()
    expect(raises("SELECT 'CREATE OR REPLACE TABLE t'")).toBeUndefined()
    expect(raises("SELECT \"ALTER TABLE t DROP COLUMN c\"")).toBeUndefined()
    expect(raises("SELECT '; DROP TABLE t; --'")).toBeUndefined()
  })

  it("does not count statements: a script's SCRIPT type is what refuses it (design D5)", () => {
    expect(raises("SELECT 1; SELECT 2")).toBeUndefined()
    expect(kinds("SELECT 1; SELECT 2").filter((kind) => kind === "keyword")).toHaveLength(2)
  })
})

describe("the lexer's policy-tag facts (design §5.3)", () => {
  it("names a column behind a table alias, backquoted and in any case", () => {
    expect(found("SELECT t.`SSN` FROM `p.d.t` AS t").columnNames.has("SSN")).toBe(true)
    expect(found("SELECT t.Ssn FROM t").columnNames.has("SSN")).toBe(true)
    expect(found("SELECT `Ssn` FROM `p.d.t`").columnNames.has("SSN")).toBe(true)
    expect(found("SELECT a FROM `p.d.t`").columnNames.has("SSN")).toBe(false)
  })

  it("sees a star, `t.*` and `COUNT(*)`, and not multiplication", () => {
    expect(found("SELECT * FROM t").usesStar).toBe(true)
    expect(found("SELECT t.* FROM `p.d.t` AS t").usesStar).toBe(true)
    expect(found("SELECT COUNT(*) FROM t").usesStar).toBe(true)
    expect(found("SELECT a * b FROM t").usesStar).toBe(false)
    expect(found("SELECT a*b, c FROM t").usesStar).toBe(false)
  })

  it("sees an alias used as a value: SELECT t, TO_JSON(t), ARRAY_AGG(t), (SELECT AS STRUCT t.*)", () => {
    expect(found("SELECT t FROM `p.d.t` AS t").aliasAsValue).toBe(true)
    expect(found("SELECT TO_JSON(t) FROM `p.d.t` t").aliasAsValue).toBe(true)
    expect(found("SELECT ARRAY_AGG(t) FROM `p.d.t` AS t").aliasAsValue).toBe(true)
    expect(found("SELECT (SELECT AS STRUCT t.*) FROM `p.d.t` AS t").aliasAsValue).toBe(true)
    // A field access is not the whole row.
    expect(found("SELECT t.a FROM `p.d.t` AS t").aliasAsValue).toBe(false)
    expect(found("SELECT * FROM `p.d.t` AS t WHERE t.a = 1").aliasAsValue).toBe(false)
  })
})

describe("the lexer's property: it never lowers a decision", () => {
  it("returns a kind at least as strict as the statement table's, for every statement type", () => {
    const samples: Readonly<Record<string, string>> = {
      SELECT: "SELECT 1",
      ASSERT: "ASSERT (SELECT COUNT(*) FROM t) > 0",
      MERGE: "MERGE t USING s ON t.id = s.id WHEN MATCHED THEN DELETE",
      CREATE_TABLE_AS_SELECT: "CREATE OR REPLACE TABLE t AS SELECT 1",
      ALTER_TABLE: "ALTER TABLE t DROP COLUMN c",
      LOAD_DATA: "LOAD DATA OVERWRITE t FROM FILES (format = 'CSV', uris = ['gs://b/x'])",
      DELETE: "DELETE FROM t WHERE TRUE",
      CALL: "CALL p()",
      SCRIPT: "EXECUTE IMMEDIATE 'select 1'",
      EXPORT_DATA: "EXPORT DATA OPTIONS (uri = 'gs://b/x/*') AS SELECT 1",
    }
    for (const [type, sql] of Object.entries(samples)) {
      const kind = kindOf(type as StatementType)
      expect(kind, type).toBeDefined()
      const raised = raise(kind!, found(sql).raisesTo)
      expect(raised, sql).toBeDefined()
      expect(["read", "write", "export", "share", "delete", "admin"]).toContain(raised)
    }
    // A plain read stays a read: no finding, no raise.
    expect(found("SELECT a FROM `p.d.t` WHERE b = 1").raisesTo).toBeUndefined()
  })

  it("only ever raises over its own classification of every statement type", () => {
    for (const type of Object.keys(STATEMENT_KINDS)) {
      const table = kindOf(type)!
      const raised = raise(table, "delete")
      expect(raised).not.toBe("read")
    }
  })
})

describe("the lexer's fuzz", async () => {
  // A deterministic generator, so a failure is reproducible: no network, no clock, no randomness from the host.
  const random = (() => {
    let state = 0x51ed270b
    return () => {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  })()
  const alphabet = "abc XYZ019_`'\"\\/*-#@?;,.<>()[]{}=+%|\n\t\u00e9"

  it("never throws: every text either lexes or refuses with a position", () => {
    for (let sample = 0; sample < 2_000; sample += 1) {
      const length = Math.floor(random() * 40)
      let sql = ""
      for (let at = 0; at < length; at += 1) sql += alphabet[Math.floor(random() * alphabet.length)]
      const result = lexText(sql)
      if (result.ok) {
        const report = lexer.findings(result.tokens)
        expect(Array.isArray(report.externalEffects)).toBe(true)
        expect(typeof report.usesStar).toBe("boolean")
      } else {
        expect(result.error.line).toBeGreaterThan(0)
        expect(result.error.column).toBeGreaterThan(0)
      }
    }
  })
})
