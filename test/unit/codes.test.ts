// One error table, and the docs that must match it exactly. A code raised anywhere in src must be in the table, and the
// README's Troubleshooting table and the configuration guide's Errors table must list exactly the table's codes; the
// scripting doc lists the tools RPC's own codes.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ERROR_CODES, ErrorCode } from "../../src/domain/errors.js"
// @ts-expect-error: a plain script, with no types
import { errorRows, withRows } from "../../scripts/docs-errors.mjs"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(path, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(path)
  }
  return out
}

/** The codes the tools RPC module itself returns for a plugin with no MCP server. */
const RPC_CODES = ["CANCELLED", "PERMISSION_DENIED", "RESOURCE_UNRESOLVED", "SESSION_AGENT_REQUIRED", "SESSION_UNKNOWN"] as const

/** The codes in the first cell of a Markdown table row that starts with one, or a row that names several. */
function tableCodes(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|")[1]?.trim() ?? "")
    .filter((cell) => cell.startsWith("`"))
    .flatMap((cell) => [...cell.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)`/g)].map((code) => code[1]!))
}

const TROUBLESHOOTING = /## Troubleshooting([\s\S]*?)## Uninstall/.exec(read("README.md"))?.[1] ?? ""
const CONFIGURATION_ERRORS = /## Errors([\s\S]*?)(?=\n## |$)/.exec(read("docs/configuration.md"))?.[1] ?? ""
const SCRIPTING_ERRORS = /## Errors([\s\S]*?)(?=\n## |$)/.exec(read("docs/scripting.md"))?.[1] ?? ""

describe("codes", () => {
  it("every code a source raises with BigQueryError or errorText is in the table", () => {
    const raised = walk("src").flatMap((file) => [...read(file).matchAll(/(?:BigQueryError|errorText)\(\s*"([A-Z][A-Z0-9_]+)"/g)].map((match) => match[1]!))
    expect(raised.filter((code) => !Object.hasOwn(ErrorCode, code))).toEqual([])
  })

  it("every entry has a meaning and a next step, each a sentence", () => {
    for (const code of ERROR_CODES) {
      const entry = ErrorCode[code] as { meaning: string; next: string }
      expect(entry.meaning, code).toMatch(/\.$/)
      expect(entry.next, code).toMatch(/\.$/)
    }
  })

  it("the docs' error rows are exactly the table's, generated", () => {
    for (const file of ["README.md", "docs/configuration.md"]) expect(withRows(read(file), errorRows()), file).toBe(read(file))
  })

  it("the README's Troubleshooting table lists exactly the plugin's codes", () => {
    expect(tableCodes(TROUBLESHOOTING).sort()).toEqual([...ERROR_CODES].sort())
  })

  it("the configuration guide's Errors table lists exactly the plugin's codes", () => {
    expect(tableCodes(CONFIGURATION_ERRORS).sort()).toEqual([...ERROR_CODES].sort())
  })

  it("docs/scripting.md's Errors table lists exactly the tools RPC's own codes", () => {
    expect(tableCodes(SCRIPTING_ERRORS).sort()).toEqual([...RPC_CODES].sort())
  })
})
