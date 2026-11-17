// Every file in the repository has exactly one owner in docs/ownership.md, so the packages build in parallel without
// editing each other's files.
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const SKIP = new Set([".git", "node_modules", "dist", "reports", ".DS_Store"])
const OWNERS = ["Day 0", "A", "B", "C", "D", "E", "F"]

function files(dir = ROOT, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.endsWith(".tgz")) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files(path, out)
    else out.push(relative(ROOT, path).split("\\").join("/"))
  }
  return out
}

/** `*` within one folder, `**` across folders. */
const glob = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`)

const rows = readFileSync(join(ROOT, "docs/ownership.md"), "utf8")
  .split("\n")
  .map((line) => /^\| `([^`]+)` \| ([^|]+) \|$/.exec(line))
  .filter((match): match is RegExpExecArray => match !== null)
  .map((match) => ({ pattern: match[1]!, owner: match[2]!.trim(), regex: glob(match[1]!) }))

describe("file ownership", () => {
  it("names a known owner on every row, and each path once", () => {
    expect(rows.length).toBeGreaterThan(50)
    for (const row of rows) expect(OWNERS, row.pattern).toContain(row.owner)
    expect(new Set(rows.map((row) => row.pattern)).size).toBe(rows.length)
  })

  it("gives every file exactly one owner", () => {
    const problems = files().flatMap((file) => {
      const owners = rows.filter((row) => row.regex.test(file))
      return owners.length === 1 ? [] : [`${file}: ${owners.length === 0 ? "no owner" : owners.map((row) => row.pattern).join(" and ")}`]
    })
    expect(problems).toEqual([])
  })

  it("gives each package the files its unbuilt port and handlers live in", () => {
    const ownerOf = (file: string) => rows.find((row) => row.regex.test(file))?.owner
    expect(ownerOf("src/auth/index.ts")).toBe("A")
    expect(ownerOf("src/process/bigquery.ts")).toBe("B")
    expect(ownerOf("src/guards/ledger.ts")).toBe("C")
    expect(ownerOf("src/handlers/reads.ts")).toBe("C")
    expect(ownerOf("src/handlers/changes.ts")).toBe("D")
    expect(ownerOf("src/handlers/sources.ts")).toBe("E")
    expect(ownerOf("src/handlers/status.ts")).toBe("F")
    expect(ownerOf("src/domain/errors.ts")).toBe("Day 0")
    expect(ownerOf("src/registry.ts")).toBe("Day 0")
  })
})
