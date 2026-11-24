// What every text says about a read the byte cap cannot bound must be true at all three access levels: the plugin's own
// rules ask at `all` and `ask-changes` and deny at `read-only`. No text may promise a prompt unqualified, and the model
// must never read the absence of a prompt as the user's consent (review bigquery-1, M-1 and M-2).
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { QueryInput, UNCAPPED_PLAN_ID } from "../../src/domain/contract.js"
import { ASKS } from "../../src/domain/actions.js"
import { ErrorCode } from "../../src/domain/errors.js"
import { defaultRules, effectOf } from "../../src/permissions.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")
const walk = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(`${dir}/${entry.name}`) : /\.(tsx?|md)$/.test(entry.name) ? [`${dir}/${entry.name}`] : [],
  )
const TEXTS = [...walk("src"), ...walk("docs"), ...walk("skills"), "README.md", "CHANGELOG.md", "SECURITY.md", "package.json"]
/** One paragraph per entry, so a qualifier on the next line still counts. */
const flat = (text: string) => text.replace(/\s+/g, " ")

describe("the uncapped-read wording", () => {
  it("tells the model to get the user's go-ahead itself, in the query schema it reads", () => {
    expect(UNCAPPED_PLAN_ID).toBe("Run an uncapped-read plan instead of sql. The user is asked before it runs: get their go-ahead in the conversation first.")
    const schema = z.toJSONSchema(QueryInput, { io: "input" }) as unknown as { properties: { planId: { description: string } } }
    expect(schema.properties.planId.description).toBe(UNCAPPED_PLAN_ID)
    expect(ErrorCode.NEEDS_PLAN.next).toContain("with their go-ahead, bigquery_query({ planId })")
  })

  it("promises no prompt unqualified, anywhere", () => {
    const promises = [/after you are asked/i, /; you are asked first"/, /after (?:the|a) person answers/i, /after the `bigquery\.uncapped_read` ask/, /needs a person to answer/i]
    const found = TEXTS.flatMap((file) => promises.filter((pattern) => pattern.test(flat(read(file)))).map((pattern) => `${relative(ROOT, join(ROOT, file))}: ${pattern}`))
    expect(found).toEqual([])
  })

  it("asks at `all` and `ask-changes`, and denies at `read-only`, in the plugin's own rules", () => {
    expect(effectOf(defaultRules("all"), ASKS.uncappedRead)).toBe("ask")
    expect(effectOf(defaultRules("ask-changes"), ASKS.uncappedRead)).toBe("ask")
    expect(effectOf(defaultRules("read-only"), ASKS.uncappedRead)).toBe("deny")
  })
})
