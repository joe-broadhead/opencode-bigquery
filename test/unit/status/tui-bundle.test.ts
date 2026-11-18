// The TUI bundle must not be minified: OpenCode's OpenTUI rewrites a TUI plugin's host imports only where
// `from\s+["']`, `import\s+["']`, `import\s*\(` or `require\s*\(` match, and a minified bundle drops the space
// (`from"x"`), so its host imports never resolve. The family guard's first regex missed several minified forms; this test
// pins the corrected one (review boxd-31, LOW 1) and builds the real TUI both ways to prove it matches only the
// minified bundle. scripts/build.mjs keeps its own guard; the pull request asks the contract keeper to carry the same
// pattern there (contract request).
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
// @ts-expect-error: @babel/core ships no declarations; scripts/build.mjs imports it the same way.
import { transformAsync } from "@babel/core"
import { build } from "esbuild"
import { describe, expect, it } from "vitest"

/** The corrected guard: a `from`/`import` that touches a quote, not right after a quote, a word character, `$`, `.` or a backquote. */
const MINIFIED_IMPORT = /(?<!["'`\w$.])(?:from|import)["']/

const ROOT = fileURLToPath(new URL("../../..", import.meta.url))
const HOST = ["@opencode/plugin", "@opencode/plugin/*", "@opentui/*", "solid-js", "solid-js/*"]

describe("the TUI bundle's minified-import guard", () => {
  it("names every statement form OpenTUI cannot rewrite, and nothing it can", () => {
    const minified = [
      'import{a}from"x"',
      'import*as a from"x"',
      'import a from"x"',
      'import a,{b}from"x"',
      'import"x"',
      'export{a}from"x"',
      'export*from"x"',
      'export*as n from"x"',
      "import{a}from'x'",
    ]
    for (const text of minified) expect([text, MINIFIED_IMPORT.test(text)]).toEqual([text, true])
    const plain = [
      'import { a } from "x"',
      'import * as a from "x"',
      'import a from "x"',
      'import "x"',
      'export * from "x"',
      'import("x")',
      'await import("x")',
      'required:["from","import"]',
      '{from:"x"}',
      'x["import"]',
      'const from = "x"',
    ]
    for (const text of plain) expect([text, MINIFIED_IMPORT.test(text)]).toEqual([text, false])
  })

  it("passes the TUI as the plugin builds it, and fails the same source minified", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bq-tui-guard-"))
    try {
      const presets = [["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }], "@babel/preset-typescript"]
      const solid = {
        name: "solid-tsx",
        setup(instance: { onLoad: (options: { filter: RegExp }, callback: (args: { path: string }) => Promise<{ contents: string; loader: "js" }>) => void }) {
          instance.onLoad({ filter: /\.tsx$/ }, async (args) => {
            const result = await transformAsync(readFileSync(args.path, "utf8"), { filename: args.path, configFile: false, babelrc: false, presets })
            if (!result?.code) throw new Error(`Babel produced no output for ${args.path}`)
            return { contents: result.code, loader: "js" as const }
          })
        },
      }
      for (const minify of [false, true]) {
        const outfile = join(dir, `tui-${minify}.js`)
        await build({
          absWorkingDir: ROOT,
          entryPoints: [join(ROOT, "src", "tui", "index.tsx")],
          outfile,
          bundle: true,
          splitting: false,
          format: "esm",
          platform: "node",
          target: "es2022",
          external: HOST,
          plugins: [solid],
          define: { __PLUGIN_VERSION__: JSON.stringify("0.0.0") },
          legalComments: "none",
          minify,
          logLevel: "warning",
        })
        const text = readFileSync(outfile, "utf8")
        // The bundle as built must be clean; the same source minified must be caught. That is the guard's whole point.
        expect([minify, MINIFIED_IMPORT.test(text)]).toEqual([minify, minify])
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
