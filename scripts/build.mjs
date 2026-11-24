// Builds dist/ as exactly two self-contained files, so an in-place plugin update can never mix
// a new entry with a stale sibling module that the host still holds:
// - dist/index.js: the server part (src/index.ts), minified;
// - dist/tui.js: the TUI part (src/tui/index.tsx). Babel compiles its JSX with OpenTUI's Solid
//   preset as esbuild loads it, so no .tsx ships or runs from node_modules. It is not minified:
//   OpenCode cannot load the minified form of its host imports from a local-path install.
// esbuild bundles each entry alone (no splitting, no chunks): shared code such as the RPC
// contract, which is plain JSON Schema, is inlined into both; zod, the source contract's tools RPC and
// google-auth-library (the opt-in ADC mode) go into dist/index.js alone. What the host provides stays a bare import:
// @opencode/plugin, OpenTUI, Solid and Node's built-ins. The build fails if an output imports anything else, or anything
// relative.
// google-auth-library is CommonJS and requires Node's built-ins by their bare names, so dist/index.js opens with a
// `require` made by node:module's createRequire, and two of its packages are replaced: node-fetch by the runtime's own
// fetch, and debug's optional supports-color by a stub; gaxios's one dynamic import of crypto becomes a static one
// (scripts/shims).
// NOTICE carries the licence of every bundled package, and nothing else. The build fails when
// NOTICE no longer matches what esbuild bundled; `node scripts/build.mjs --notice` rewrites it.
// Sources import zod as `import * as z`, which lets esbuild leave out what is unused.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { transformAsync } from "@babel/core"
import { build } from "esbuild"

const root = fileURLToPath(new URL("../", import.meta.url))
const dist = join(root, "dist")
const HOST_PROVIDED = ["@opencode/plugin", "@opencode/plugin/*", "@opentui/*", "solid-js", "solid-js/*"]
const allowed = (path) =>
  path.startsWith("node:") || builtinModules.includes(path) || HOST_PROVIDED.some((name) => (name.endsWith("/*") ? path.startsWith(name.slice(0, -1)) : path === name))
/** Bundled in place of packages the server part must not carry (scripts/shims). */
const ALIAS = { "node-fetch": join(root, "scripts", "shims", "node-fetch.mjs"), "supports-color": join(root, "scripts", "shims", "supports-color.cjs") }
/** A dynamic `import("crypto")` in gaxios, resolved to a static import so the bundle makes no dynamic import. */
const staticCrypto = {
  name: "static-crypto",
  setup(build) {
    build.onResolve({ filter: /^crypto$/ }, (args) => (args.kind === "dynamic-import" ? { path: join(root, "scripts", "shims", "crypto.mjs") } : undefined))
  },
}
/** CommonJS in an ES module bundle: its `require` of a built-in needs a real `require`. */
const REQUIRE_BANNER = 'import { createRequire as __bigqueryCreateRequire } from "node:module"; const require = __bigqueryCreateRequire(import.meta.url);'

// The plugin's version, for src/version.ts; no source file repeats it.
const VERSION = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version
const presets = [["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }], "@babel/preset-typescript"]
// A minified bundle writes its imports without spaces (`from"x"`, `import{a}`). The TUI part must keep them plain.
const MINIFIED_IMPORT = /(?<!["'`\w$.])(?:from|import)["']/

/** Compiles .tsx with Babel's Solid preset as esbuild loads it; esbuild handles plain .ts itself. */
const solid = {
  name: "solid-tsx",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => {
      const result = await transformAsync(readFileSync(args.path, "utf8"), { filename: args.path, configFile: false, babelrc: false, presets })
      if (!result?.code) throw new Error(`Babel produced no output for ${relative(root, args.path)}`)
      return { contents: result.code, loader: "js" }
    })
  },
}

async function bundle(entry, outfile, plugins = [], minify = true, server = false) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(root, entry)],
    outfile: join(dist, outfile),
    bundle: true,
    splitting: false,
    minify,
    format: "esm",
    platform: "node",
    target: "es2022",
    external: HOST_PROVIDED,
    plugins,
    ...(server ? { alias: ALIAS, banner: { js: REQUIRE_BANNER } } : {}),
    define: { __PLUGIN_VERSION__: JSON.stringify(VERSION) },
    legalComments: "inline",
    metafile: true,
    logLevel: "warning",
  })
  const unexpected = Object.values(result.metafile.outputs).flatMap((output) =>
    output.imports.filter((item) => item.external && !allowed(item.path)).map((item) => item.path),
  )
  if (unexpected.length > 0) throw new Error(`dist/${outfile} imports modules that are neither bundled nor provided by the host: ${unexpected.join(", ")}`)
  return result.metafile
}

/** Checks NOTICE against the packages in the bundles (or rewrites it with --notice). */
function checkNotice(metafiles) {
  const inputs = metafiles.flatMap((metafile) => Object.keys(metafile.inputs))
  const packages = new Set(inputs.flatMap((input) => /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1] ?? []))
  const sections = [...packages].sort().map((name) => {
    const dir = join(root, "node_modules", name)
    const { version, license } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    const file = readdirSync(dir).find((entry) => /^(licen[cs]e|copying)(\.|$)/i.test(entry))
    if (!file) throw new Error(`${name} is bundled but ships no licence file`)
    return `## ${name} ${version} (${license})\n\n${readFileSync(join(dir, file), "utf8").trim()}\n`
  })
  const notice = `bigquery-plugin bundles this third-party code into dist/.\n\n${sections.join("\n")}`
  const path = join(root, "NOTICE")
  if (process.argv.includes("--notice")) writeFileSync(path, notice)
  else if (!existsSync(path) || readFileSync(path, "utf8") !== notice) {
    throw new Error("NOTICE does not match the bundled packages. Run `node scripts/build.mjs --notice` to rewrite it.")
  }
}

try {
  rmSync(dist, { recursive: true, force: true })
  const server = await bundle("src/index.ts", "index.js", [staticCrypto], true, true)
  const tui = await bundle("src/tui/index.tsx", "tui.js", [solid], false)
  if (MINIFIED_IMPORT.test(readFileSync(join(dist, "tui.js"), "utf8"))) throw new Error("dist/tui.js is minified. OpenCode cannot load its host imports from a local-path install, so bundle the TUI part with minify false.")
  checkNotice([server, tui])
  const files = readdirSync(dist, { recursive: true }).map(String).sort()
  if (files.join(",") !== "index.js,tui.js") throw new Error(`dist/ must hold exactly index.js and tui.js, found: ${files.join(", ")}`)
} catch (error) {
  console.error(`build failed: ${error.message}`)
  process.exitCode = 1
}
