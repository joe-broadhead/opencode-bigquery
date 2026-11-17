// Reads the statementType enum from Google's Job resource page and writes test/fixtures/statement-types.json. Run by
// hand, never in CI: `node scripts/statement-types.mjs`. src/domain/statements.ts must then map every value, and
// test/unit/statements.test.ts fails until it does, so a type Google adds is classified before it can run.
import { writeFileSync } from "node:fs"

const SOURCE = "https://cloud.google.com/bigquery/docs/reference/rest/v2/Job"
const page = await (await fetch(SOURCE)).text()
const text = page.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;|&#\d+;/g, " ").replace(/\s+/g, " ")
const start = text.indexOf("statementType string Output only.")
if (start === -1) throw new Error("statementType's description was not found on the page")
const end = text.indexOf("totalBytesBilled", start)
const values = [...text.slice(start, end === -1 ? start + 20_000 : end).matchAll(/\b([A-Z][A-Z_]+[A-Z]) : /g)].map((match) => match[1])
if (values.length < 70) throw new Error(`only ${values.length} values were read; the page's form may have changed`)
const fixture = { source: SOURCE, read: new Date().toISOString().slice(0, 10), values }
writeFileSync(new URL("../test/fixtures/statement-types.json", import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`)
console.log(`${values.length} statement types written`)
