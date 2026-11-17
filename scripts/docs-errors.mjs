// Writes the error rows of README.md's Troubleshooting table and docs/configuration.md's Errors table from the one table
// in src/domain/errors.ts, between the `errors:start` and `errors:end` markers. `--check` fails instead of writing when a
// file differs, which test/unit/codes.test.ts also checks. Node loads the table by stripping its types.
//   node scripts/docs-errors.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs"

const { ErrorCode, ERROR_CODES } = await import(new URL("../src/domain/errors.ts", import.meta.url).href)
const START = "<!-- errors:start -->"
const END = "<!-- errors:end -->"

export function errorRows() {
  const cell = (text) => text.replaceAll("|", "\\|")
  return ["| Code | What happened | Next step |", "| --- | --- | --- |", ...ERROR_CODES.map((code) => `| \`${code}\` | ${cell(ErrorCode[code].meaning)} | ${cell(ErrorCode[code].next)} |`)].join("\n")
}

export function withRows(text, rows = errorRows()) {
  const start = text.indexOf(START)
  const end = text.indexOf(END)
  if (start === -1 || end < start) throw new Error("the errors:start and errors:end markers are missing or out of order")
  return `${text.slice(0, start + START.length)}\n${rows}\n${text.slice(end)}`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check")
  let stale = 0
  for (const file of ["README.md", "docs/configuration.md"]) {
    const path = new URL(`../${file}`, import.meta.url)
    const text = readFileSync(path, "utf8")
    const next = withRows(text)
    if (next === text) continue
    if (check) {
      console.error(`${file}: the error rows differ from src/domain/errors.ts. Run node scripts/docs-errors.mjs.`)
      stale++
    } else writeFileSync(path, next)
  }
  process.exit(stale === 0 ? 0 : 1)
}
