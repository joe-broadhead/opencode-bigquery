// The source contract's declaration checks over the `sources` block package.json declares. The scaffold declares no
// source yet; the plugin's contract adds the block and the checks.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { sources?: unknown }

test("declares no source until the contract", () => {
  expect(pkg.sources).toBeUndefined()
})
