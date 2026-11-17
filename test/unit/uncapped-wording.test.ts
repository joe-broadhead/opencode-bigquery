// What every text says about a read the byte cap cannot bound must be true at all three access levels: in local
// OpenCode the plugin's rules ask at `all` and `ask-changes` and deny at `read-only`; in Jelly, Allowed runs it without
// asking (D165) and the other two ask. No text may promise a prompt unqualified, and the model must never read the
// absence of a prompt as the user's consent (review bigquery-1, M-1 and M-2).
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { QueryInput, UNCAPPED_PLAN_ID } from "../../src/domain/contract.js"
import { ErrorCode } from "../../src/domain/errors.js"

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
    expect(UNCAPPED_PLAN_ID).toBe("Run an uncapped-read plan instead of sql. The user may not be asked first (Jelly's Allowed): get the user's go-ahead in the conversation before you run it.")
    const schema = z.toJSONSchema(QueryInput, { io: "input" }) as unknown as { properties: { planId: { description: string } } }
    expect(schema.properties.planId.description).toBe(UNCAPPED_PLAN_ID)
    expect(ErrorCode.NEEDS_PLAN.next).toContain("with their go-ahead, bigquery_query({ planId })")
  })

  it("promises no prompt unqualified, anywhere", () => {
    const promises = [/after you are asked/i, /; you are asked first"/, /after (?:the|a) person answers/i, /after the `bigquery\.uncapped_read` ask/, /needs a person to answer/i]
    const found = TEXTS.flatMap((file) => promises.filter((pattern) => pattern.test(flat(read(file)))).map((pattern) => `${relative(ROOT, join(ROOT, file))}: ${pattern}`))
    expect(found).toEqual([])
  })

  it("says what Jelly's Allowed does wherever the uncapped read is explained to people", () => {
    const pinned: Record<string, string[]> = {
      "README.md": ["In Jelly, under Allowed it runs without asking, bounded only by that time limit and your budget if you set one; under Ask before changes or Read only, Jelly asks you first."],
      "docs/jelly.md": ["With Jelly's rules it runs without asking at Allowed, and asks at Ask before changes and at Read only", "Choose Ask before changes to be asked first."],
      "docs/configuration.md": ["in Jelly, Allowed runs it without asking", "Jelly writes its own: under Allowed it runs such a read without asking, bounded by the 120-second job limit and your budget if set; under Ask before changes and Read only it asks."],
      "skills/opencode-bigquery/SKILL.md": ["the user may not be asked first (in Jelly under Allowed it runs at once), so show the preview and wait for the user's go-ahead yourself."],
      "package.json": ["One the cap cannot bound runs from a plan: under Allowed without asking, limited to 120 seconds and your budget if set; otherwise you are asked first"],
    }
    for (const [file, sentences] of Object.entries(pinned)) for (const sentence of sentences) expect(flat(read(file)), file).toContain(sentence)
  })
})
