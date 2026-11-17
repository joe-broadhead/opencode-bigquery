// Design §14.1 "Cost": the cap arithmetic, COST_CAP and BYTES_BILLED_LIMIT (the tool tests), the budget from actual
// bytes across two processes, and the ledger that counts them.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { BigQueryError } from "../../../src/domain/errors.js"
import { capAndBudget, formatBytes, localDayStart, usdFor } from "../../../src/guards/cost.js"
import { createLedger } from "../../../src/guards/ledger.js"
import { FakeLedger, fakePorts } from "../../fake/ports.js"
import { loadOptions } from "../../../src/options.js"

const folders: string[] = []
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "bq-cost-"))
  folders.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true })
})

const NOW = Date.parse("2026-11-17T12:00:00Z")
const entry = (overrides: Partial<Parameters<FakeLedger["record"]>[0]> = {}) => ({
  at: new Date(NOW).toISOString(),
  account: "default",
  project: "invented-proj",
  location: "US",
  jobId: "oc_1",
  bytesBilled: 10,
  via: "bigquery_query",
  session: "abcdefabcdefabcd",
  ...overrides,
})

const options = (extra: Record<string, unknown> = {}) => loadOptions({ budget: extra })

describe("the cap's arithmetic (§6.2)", () => {
  const ports = () => fakePorts()

  it("is the default cap, lowered by the call but never by the ceiling", async () => {
    expect((await capAndBudget({ options: loadOptions({}), ports: ports(), account: "default", session: "s", now: NOW, estimateBytes: 0 })).capBytes).toBe(10 * 2 ** 30)
    expect((await capAndBudget({ options: loadOptions({}), ports: ports(), account: "default", session: "s", now: NOW, estimateBytes: 0, requested: 2 ** 30 })).capBytes).toBe(2 ** 30)
    // Above the ceiling is refused, not silently lowered.
    await expect(capAndBudget({ options: loadOptions({}), ports: ports(), account: "default", session: "s", now: NOW, estimateBytes: 0, requested: 200 * 2 ** 30 })).rejects.toMatchObject({
      code: "INPUT_INVALID",
    })
  })

  it("is what the daily budget leaves, and a spent budget refuses", async () => {
    const ports = fakePorts()
    ports.ledger.entries.push(entry({ bytesBilled: 9 * 2 ** 30 }))
    const answer = await capAndBudget({ options: options({ daily: 10 * 2 ** 30, action: "refuse" }), ports, account: "default", session: "s", now: NOW, estimateBytes: 1 })
    expect(answer.capBytes).toBe(2 ** 30)

    ports.ledger.entries.push(entry({ bytesBilled: 2 * 2 ** 30 }))
    await expect(capAndBudget({ options: options({ daily: 10 * 2 ** 30, action: "refuse" }), ports, account: "default", session: "s", now: NOW, estimateBytes: 1 })).rejects.toBeInstanceOf(BigQueryError)
  })

  it("counts a session budget from this session's hash only", async () => {
    const ports = fakePorts()
    ports.ledger.entries.push(entry({ bytesBilled: 3 * 2 ** 30, session: "other" }))
    ports.ledger.entries.push(entry({ bytesBilled: 2 ** 30, session: "mine" }))
    const answer = await capAndBudget({ options: options({ session: 4 * 2 ** 30, action: "refuse" }), ports, account: "default", session: "mine", now: NOW, estimateBytes: 1 })
    expect(answer.capBytes).toBe(3 * 2 ** 30)
  })

  it("warns when less than a tenth of the budget is left, and lets a warn budget through when spent", async () => {
    const near = fakePorts()
    near.ledger.entries.push(entry({ bytesBilled: 9.5 * 2 ** 30 }))
    const warned = await capAndBudget({ options: options({ daily: 10 * 2 ** 30, action: "refuse" }), ports: near, account: "default", session: "s", now: NOW, estimateBytes: 0 })
    expect(warned.warnings.map((warning) => warning.code)).toEqual(["BUDGET_WARN"])

    const spent = fakePorts()
    spent.ledger.entries.push(entry({ bytesBilled: 11 * 2 ** 30 }))
    const through = await capAndBudget({ options: options({ daily: 10 * 2 ** 30, action: "warn" }), ports: spent, account: "default", session: "s", now: NOW, estimateBytes: 0 })
    expect(through.capBytes).toBe(10 * 2 ** 30)
    expect(through.warnings.map((warning) => warning.code)).toEqual(["BUDGET_WARN"])
  })

  it("starts a local day at local midnight", () => {
    const start = new Date(localDayStart(NOW))
    expect([start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()]).toEqual([0, 0, 0, 0])
    expect(start.getTime()).toBeLessThanOrEqual(NOW)
  })

  it("prices at the configured rate per TiB, and writes bytes as a number and a unit", () => {
    expect(usdFor(2 ** 40, loadOptions({}))).toBeCloseTo(6.25)
    expect(usdFor(0, loadOptions({}))).toBe(0)
    expect(formatBytes(10 * 2 ** 30)).toBe("10 GiB")
    expect(formatBytes(1536)).toBe("1.5 KiB")
    expect(formatBytes(9)).toBe("9 B")
  })
})

describe("the spend ledger (§6.2 item 4)", () => {
  it("writes one line per job, 0600, and sums what it holds", async () => {
    const dir = folder()
    const ledger = createLedger({ stateDir: dir })
    await ledger.record(entry({ bytesBilled: 100 }))
    await ledger.record(entry({ bytesBilled: 250, session: "other" }))
    expect(await ledger.spent({ account: "default", since: 0 })).toBe(350)
    expect(await ledger.spent({ account: "default", since: 0, session: "abcdefabcdefabcd" })).toBe(100)
    expect(await ledger.spent({ account: "someone", since: 0 })).toBe(0)
    expect(await ledger.spent({ account: "default", since: NOW + 1 })).toBe(0)
    const file = join(dir, "spend.jsonl")
    const lines = readFileSync(file, "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ account: "default", bytesBilled: 100, via: "bigquery_query" })
    expect(statSync(file).mode & 0o077).toBe(0)
  })

  it("takes concurrent appends from two ledgers without a torn or interleaved line", async () => {
    const dir = folder()
    const first = createLedger({ stateDir: dir })
    const second = createLedger({ stateDir: dir })
    await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? first : second).record(entry({ jobId: `oc_${index}`, bytesBilled: 1 }))))
    expect(await first.spent({ account: "default", since: 0 })).toBe(40)
    const lines = readFileSync(join(dir, "spend.jsonl"), "utf8").trim().split("\n")
    expect(lines).toHaveLength(40)
    expect(lines.map((line) => JSON.parse(line).jobId).sort()).toEqual(Array.from({ length: 40 }, (_, index) => `oc_${index}`).sort())
  })

  it("counts from two processes, which is what a budget is for", async () => {
    const dir = folder()
    const ledgerUrl = new URL("../../../src/guards/ledger.ts", import.meta.url).href
    const script = `import(${JSON.stringify(ledgerUrl)}).then(async (m) => {
      const ledger = m.createLedger({ stateDir: process.env.LEDGER_DIR })
      for (let i = 0; i < 15; i += 1) await ledger.record({ at: new Date().toISOString(), account: "default", project: "p", location: "US", jobId: "oc_" + process.pid + "_" + i, bytesBilled: 2, via: "bigquery_query", session: "s" })
    })`
    for (let child = 0; child < 2; child += 1) {
      execFileSync(process.execPath, ["-e", script], { env: { ...process.env, LEDGER_DIR: dir }, stdio: "pipe" })
    }
    expect(await createLedger({ stateDir: dir }).spent({ account: "default", since: 0 })).toBe(4 * 15)
    expect(readFileSync(join(dir, "spend.jsonl"), "utf8").trim().split("\n")).toHaveLength(30)
  })

  it("ignores a torn final line, which is a write that never finished", async () => {
    const dir = folder()
    writeFileSync(join(dir, "spend.jsonl"), `${JSON.stringify(entry({ bytesBilled: 5 }))}\n{"at":"2026-11-17T12:00:00.000Z","account":"def`)
    expect(await createLedger({ stateDir: dir }).spent({ account: "default", since: 0 })).toBe(5)
  })

  it("breaks a lock left by a dead process, and writes anyway when a live one holds it too long", async () => {
    const dir = folder()
    writeFileSync(join(dir, "spend.jsonl.lock"), "99999")
    const old = new Date(Date.now() - 60_000)
    utimesSync(join(dir, "spend.jsonl.lock"), old, old)
    await createLedger({ stateDir: dir, sleep: () => undefined }).record(entry({ bytesBilled: 7 }))
    expect(await createLedger({ stateDir: dir }).spent({ account: "default", since: 0 })).toBe(7)
    // A lock that is still fresh: the append is one atomic write, so it lands and the lock is left as it was.
    writeFileSync(join(dir, "spend.jsonl.lock"), "1")
    await createLedger({ stateDir: dir, sleep: () => undefined }).record(entry({ bytesBilled: 11 }))
    expect(await createLedger({ stateDir: dir }).spent({ account: "default", since: 0 })).toBe(18)
  })
})
