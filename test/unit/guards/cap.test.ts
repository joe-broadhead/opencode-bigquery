// Design §14.1 "Cap-enforceability" and the L7 probes: each condition of §5.1 step 7 on its own flips the answer, and
// the row-access check is the one Google gives every caller — metadata where permitted, otherwise a free dry-run probe
// that never reads a policy-tagged column, plus the `tabledata.list` probe.
import { describe, expect, it } from "vitest"
import { TtlCache } from "../../../src/guards/cache.js"
import { capVerdict } from "../../../src/guards/cap.js"
import { RowPolicyProber, type RowVerdict } from "../../../src/guards/rowpolicy.js"
import { tableFacts, type TableFacts } from "../../../src/guards/tables.js"
import { BigQueryError } from "../../../src/domain/errors.js"
import type { DryRunStatistics, TableInfo } from "../../../src/domain/google.js"
import { fakePorts } from "../../fake/ports.js"
import { ACCOUNT, DATASET, LOCATION, PROJECT, TABLE, callsOf, nativeTable, one, statistics } from "../reads/support.js"

const TABLE_PATH = `${PROJECT}.${DATASET}.${TABLE}`
const factsOf = (overrides: Partial<TableInfo> = {}): TableFacts => tableFacts(nativeTable(overrides))

/** `capVerdict` with the row check answered by the test. */
const verdict = (input: { statistics?: DryRunStatistics; bytes?: number; tables?: readonly TableFacts[]; effects?: readonly string[]; row?: RowVerdict } = {}) =>
  capVerdict({
    statistics: input.statistics ?? statistics(),
    bytes: input.bytes ?? 1_048_576,
    tables: input.tables ?? [factsOf()],
    effects: input.effects ?? [],
    rowPolicy: async () => input.row ?? { state: "none" },
  })

describe("cap-enforceability, one condition at a time (§5.1 step 7)", () => {
  it("holds for a precise or upper-bound estimate over native storage with no row policy", async () => {
    expect(await verdict()).toEqual({ enforceable: true })
    expect(await verdict({ statistics: statistics({ totalBytesProcessedAccuracy: "UPPER_BOUND" }) })).toEqual({ enforceable: true })
  })

  it("fails for a lower-bound, unknown or absent accuracy", async () => {
    expect((await verdict({ statistics: statistics({ totalBytesProcessedAccuracy: "LOWER_BOUND" }) })).whyNot).toContain("lower bound")
    expect((await verdict({ statistics: statistics({ totalBytesProcessedAccuracy: "UNKNOWN" }) })).whyNot).toContain("unknown")
    expect((await verdict({ statistics: statistics({ totalBytesProcessedAccuracy: undefined }) })).whyNot).toContain("no estimate accuracy")
  })

  it("fails for an external, BigLake, object or Omni table, whatever the caller can read", async () => {
    for (const [name, table] of [
      ["external", nativeTable({ externalDataConfiguration: { sourceUris: ["gs://invented/x.csv"] } })],
      ["type EXTERNAL", nativeTable({ type: "EXTERNAL" })],
      ["BigLake", nativeTable({ biglakeConfiguration: { connectionId: "invented" } })],
      ["object table", nativeTable({ type: "EXTERNAL", externalDataConfiguration: { objectMetadata: "SIMPLE" } })],
      ["Omni", nativeTable({ location: "aws-us-east-1" })],
    ] as const) {
      const answer = await verdict({ tables: [tableFacts(table)] })
      expect(answer.enforceable, name).toBe(false)
      expect(answer.whyNot, name).toMatch(/is an external table|is a BigLake table|is an Omni/)
    }
  })

  it("fails for a table whose type it does not know", async () => {
    const answer = await verdict({ tables: [tableFacts(nativeTable({ type: "SOMETHING_NEW" }))] })
    expect(answer.enforceable).toBe(false)
    expect(answer.whyNot).toContain("does not classify")
  })

  it("fails for a row access policy, and for a check that could not be completed", async () => {
    expect((await verdict({ row: { state: "secured", how: "policy" } })).whyNot).toContain("row access policy")
    expect((await verdict({ row: { state: "unknown", why: "the probe errored" } })).whyNot).toContain("could not be completed")
  })

  it("fails when the query estimates 0 bytes over a table that holds data, and holds over an empty one", async () => {
    const answer = await verdict({ bytes: 0 })
    expect(answer.enforceable).toBe(false)
    expect(answer.whyNot).toContain("0 bytes")
    expect((await verdict({ bytes: 0, tables: [factsOf({ numBytes: "0" })] })).enforceable).toBe(true)
  })

  it("fails for a function billed outside the bytes", async () => {
    const answer = await verdict({ effects: ["ML.GENERATE_TEXT"] })
    expect(answer.enforceable).toBe(false)
    expect(answer.whyNot).toContain("ML.GENERATE_TEXT")
  })

  it("names the table with validated identifiers, never Google's text", async () => {
    const ugly = await verdict({ tables: [factsOf({ tableReference: { projectId: PROJECT, datasetId: DATASET, tableId: "we`ird name" }, type: "EXTERNAL" })] })
    expect(ugly.whyNot).toContain("`object`")
    expect(ugly.whyNot).not.toContain("we`ird")
  })
})

/** A prober over the fakes, with a clock the test can move. */
function prober(table: TableInfo = nativeTable()) {
  const ports = fakePorts()
  const clock = { time: Date.parse("2026-11-17T12:00:00Z") }
  const facts = tableFacts(table)
  const check = new RowPolicyProber({ ports, account: ACCOUNT, project: PROJECT, signal: new AbortController().signal }, new TtlCache<RowVerdict>(10 * 60_000, () => clock.time))
  return { ports, facts, clock, prober: check }
}

describe("the row-access check, whatever the caller sees (L7)", () => {
  it("takes rowAccessPolicies.list as definitive: an empty list probes nothing", async () => {
    const { prober: check, ports } = prober()
    ports.bigquery.on("listRowAccessPolicies", async () => ({ items: [] }))
    expect(await check.probe(factsOf())).toEqual({ state: "none" })
    expect(ports.bigquery.calls.map((call) => call.method)).toEqual(["listRowAccessPolicies"])
  })

  it("takes a listed policy as row-secured, whatever the caller can see", async () => {
    const { prober: check, ports } = prober()
    ports.bigquery.on("listRowAccessPolicies", async () => ({ items: [{ policyId: "invented" }] }))
    expect(await check.probe(factsOf())).toEqual({ state: "secured", how: "policy" })
    expect(ports.bigquery.calls.map((call) => call.method)).toEqual(["listRowAccessPolicies"])
  })

  it("on a 403 for a Data Viewer, probes with plain SELECT * and a 0 estimate over a non-empty table is row-secured", async () => {
    const { prober: check, ports } = prober()
    ports.bigquery.on("listRowAccessPolicies", async () => {
      throw new BigQueryError("PERMISSION_DENIED", "rowAccessPolicies.list is refused")
    })
    ports.bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: statistics({ totalBytesProcessed: "0" }) }))
    expect(await check.probe(factsOf())).toEqual({ state: "secured", how: "zero-bytes" })
    const sql = one(callsOf(ports.bigquery, "dryRun"))[0] as { sql: string }
    expect(sql.sql).toBe(`SELECT * FROM \`${TABLE_PATH}\``)
    expect(sql.sql).not.toContain("EXCEPT")
  })

  it("never writes SELECT * EXCEPT () for a table with no tagged column (review round 4, LOW 1)", async () => {
    expect(await probeSqlFor(nativeTable())).toBe(`SELECT * FROM \`${TABLE_PATH}\``)
  })

  it("leaves a tagged column out, and a column-level denial drops that column and probes again — never row-secured", async () => {
    const tagged = nativeTable({
      schema: {
        fields: [
          { name: "id", type: "INT64" },
          { name: "flagged", type: "STRING" },
          { name: "ssn", type: "STRING", policyTags: { names: ["projects/p/locations/us/taxonomies/1/policyTags/2"] } },
        ],
      },
    })
    const { prober: check, ports } = prober(tagged)
    ports.bigquery.on("listRowAccessPolicies", async () => {
      throw new BigQueryError("PERMISSION_DENIED", "rowAccessPolicies.list is refused")
    })
    const probes: string[] = []
    ports.bigquery.on("dryRun", async (request: { sql: string }) => {
      probes.push(request.sql)
      // The first probe still reads `flagged` through `*`: the schema showed no tag on it, but a column policy denies it.
      if (request.sql === `SELECT * EXCEPT (\`ssn\`) FROM \`${TABLE_PATH}\``) {
        throw new BigQueryError("COLUMN_DENIED", "a column-level denial", undefined, {
          googleError: { message: "Access Denied: User does not have permission to access policy tag 'projects/p/locations/us/taxonomies/9/policyTags/9' on column 'flagged'", trust: "untrusted" },
        })
      }
      return { location: LOCATION, statistics: statistics({ totalBytesProcessed: "2048" }) }
    })
    ports.bigquery.on("listTableData", async () => ({ complete: true, rows: [] }))
    expect(await check.probe(tableFacts(tagged))).toEqual({ state: "none" })
    expect(probes[0]).toBe(`SELECT * EXCEPT (\`ssn\`) FROM \`${TABLE_PATH}\``)
    expect(probes[1]).toBe(`SELECT * EXCEPT (\`ssn\`, \`flagged\`) FROM \`${TABLE_PATH}\``)
  })

  it("probes every column tagged one at a time, widest type first, and a 0 for all of them is row-secured", async () => {
    const allTagged = nativeTable({
      schema: {
        fields: [
          { name: "n", type: "INT64", policyTags: { names: ["projects/p/locations/us/taxonomies/1/policyTags/1"] } },
          { name: "s", type: "STRING", policyTags: { names: ["projects/p/locations/us/taxonomies/1/policyTags/2"] } },
        ],
      },
    })
    const { prober: check, ports } = prober(allTagged)
    ports.bigquery.on("listRowAccessPolicies", async () => {
      throw new BigQueryError("PERMISSION_DENIED", "rowAccessPolicies.list is refused")
    })
    const probes: string[] = []
    ports.bigquery.on("dryRun", async (request: { sql: string }) => {
      probes.push(request.sql)
      return { location: LOCATION, statistics: statistics({ totalBytesProcessed: "0" }) }
    })
    expect(await check.probe(tableFacts(allTagged))).toEqual({ state: "secured", how: "zero-bytes" })
    // The widest type is STRING, so `s` is tried before `n`, and `SELECT * EXCEPT (all)` is never written.
    expect(probes).toEqual([`SELECT \`s\` FROM \`${TABLE_PATH}\``, `SELECT \`n\` FROM \`${TABLE_PATH}\``])
  })

  it("a refused tabledata.list probe is row-secured", async () => {
    const { prober: check, ports } = prober()
    ports.bigquery.on("listRowAccessPolicies", async () => {
      throw new BigQueryError("PERMISSION_DENIED", "rowAccessPolicies.list is refused")
    })
    ports.bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: statistics({ totalBytesProcessed: "2048" }) }))
    ports.bigquery.on("listTableData", async () => {
      throw new BigQueryError("PERMISSION_DENIED", "a TRUE filter is required")
    })
    expect(await check.probe(factsOf())).toEqual({ state: "secured", how: "tabledata" })
  })

  it("a tabledata.list probe error this version cannot classify is unknown, which sends the query to a plan", async () => {
    const { prober: check, ports } = prober()
    ports.bigquery.on("listRowAccessPolicies", async () => {
      throw new BigQueryError("PERMISSION_DENIED", "rowAccessPolicies.list is refused")
    })
    ports.bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: statistics({ totalBytesProcessed: "2048" }) }))
    ports.bigquery.on("listTableData", async () => {
      throw new BigQueryError("UNAVAILABLE", "a 503")
    })
    expect(await check.probe(factsOf())).toEqual({ state: "unknown", why: expect.stringContaining("tabledata.list") })
  })

  it("adds a partition filter that cannot prune to nothing, for DATE, TIMESTAMP, integer-range and ingestion time", async () => {
    expect(await probeSqlFor(nativeTable({ timePartitioning: { type: "DAY", field: "day", requirePartitionFilter: true }, schema: { fields: [{ name: "day", type: "DATE" }] } }))).toContain(
      "WHERE `day` >= DATE '0001-01-01' OR `day` IS NULL",
    )
    expect(await probeSqlFor(nativeTable({ timePartitioning: { type: "DAY", field: "day", requirePartitionFilter: true }, schema: { fields: [{ name: "day", type: "TIMESTAMP" }] } }))).toContain(
      "WHERE `day` >= TIMESTAMP '0001-01-01 00:00:00+00' OR `day` IS NULL",
    )
    expect(
      await probeSqlFor(nativeTable({ rangePartitioning: { field: "n", range: { start: "0", end: "1000", interval: "100" } }, requirePartitionFilter: true, schema: { fields: [{ name: "n", type: "INT64" }] } })),
    ).toContain("WHERE `n` >= -9223372036854775808 OR `n` IS NULL")
    expect(await probeSqlFor(nativeTable({ timePartitioning: { type: "DAY", requirePartitionFilter: true }, schema: { fields: [{ name: "id", type: "INT64" }] } }))).toContain(
      "WHERE _PARTITIONTIME >= TIMESTAMP '0001-01-01 00:00:00+00' OR _PARTITIONTIME IS NULL",
    )
  })

  it("caches the answer for ten minutes per table", async () => {
    const { prober: check, ports, clock, facts } = prober()
    ports.bigquery.on("listRowAccessPolicies", async () => ({ items: [] }))
    expect(await check.probe(facts)).toEqual({ state: "none" })
    expect(await check.probe(facts)).toEqual({ state: "none" })
    expect(callsOf(ports.bigquery, "listRowAccessPolicies")).toHaveLength(1)
    clock.time += 10 * 60_000 + 1
    expect(await check.probe(facts)).toEqual({ state: "none" })
    expect(callsOf(ports.bigquery, "listRowAccessPolicies")).toHaveLength(2)
  })
})

/** The probe SQL a fresh prober sends for this table. */
async function probeSqlFor(table: TableInfo): Promise<string> {
  const { prober: check, ports } = prober(table)
  ports.bigquery.on("listRowAccessPolicies", async () => {
    throw new BigQueryError("PERMISSION_DENIED", "rowAccessPolicies.list is refused")
  })
  ports.bigquery.on("dryRun", async () => ({ location: LOCATION, statistics: statistics({ totalBytesProcessed: "1" }) }))
  ports.bigquery.on("listTableData", async () => ({ complete: true, rows: [] }))
  await check.probe(tableFacts(table))
  return (one(callsOf(ports.bigquery, "dryRun"))[0] as { sql: string }).sql
}
