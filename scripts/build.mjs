// Builds dist/index.js as one self-contained bundle: every module the plugin imports is inlined except the host's
// `@opencode/plugin` and Node's built-ins. The build refuses an output that imports anything else, and refuses to ship
// without a NOTICE that matches what it bundled.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
const HOST_PROVIDED = ["@opencode/plugin", "@opencode/plugin/*"];
const allowed = (path) => path.startsWith("node:") || builtinModules.includes(path) || HOST_PROVIDED.some((name) => (name.endsWith("/*") ? path.startsWith(name.slice(0, -1)) : path === name));

const VERSION = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

async function bundle() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(root, "src/index.ts")],
    outfile: join(dist, "index.js"),
    bundle: true,
    splitting: false,
    minify: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    external: HOST_PROVIDED,
    define: { __PLUGIN_VERSION__: JSON.stringify(VERSION) },
    legalComments: "inline",
    metafile: true,
    logLevel: "warning",
  });
  const unexpected = Object.values(result.metafile.outputs).flatMap((output) => output.imports.filter((item) => item.external && !allowed(item.path)).map((item) => item.path));
  if (unexpected.length > 0) throw new Error(`dist/index.js imports modules that are neither bundled nor provided by the host: ${unexpected.join(", ")}`);
  return result.metafile;
}

/** Checks NOTICE against the packages in the bundle (or rewrites it with --notice). */
function checkNotice(metafile) {
  const inputs = Object.keys(metafile.inputs);
  const packages = new Set(inputs.flatMap((input) => /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1] ?? []));
  const sections = [...packages].sort().map((name) => {
    const dir = join(root, "node_modules", name);
    const { version, license } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const file = readdirSync(dir).find((entry) => /^(licen[cs]e|copying)(\.|$)/i.test(entry));
    if (!file) throw new Error(`${name} is bundled but ships no licence file`);
    return `## ${name} ${version} (${license})\n\n${readFileSync(join(dir, file), "utf8").trim()}\n`;
  });
  const notice = `bigquery-plugin bundles this third-party code into dist/.\n\n${sections.join("\n")}`;
  const path = join(root, "NOTICE");
  if (process.argv.includes("--notice")) writeFileSync(path, notice);
  else if (!existsSync(path) || readFileSync(path, "utf8") !== notice) throw new Error("NOTICE does not match the bundled packages. Run `node scripts/build.mjs --notice` to rewrite it.");
}

try {
  rmSync(dist, { recursive: true, force: true });
  const metafile = await bundle();
  checkNotice(metafile);
  const files = readdirSync(dist, { recursive: true }).map(String).sort();
  if (files.join(",") !== "index.js") throw new Error(`dist/ must hold exactly index.js, found: ${files.join(", ")}`);
  console.log(`bundle: dist/index.js (${VERSION}), ${Object.keys(metafile.inputs).length} inputs`);
} catch (error) {
  console.error(`bundle failed: ${relative(root, process.cwd()) === "" ? "" : ""}${error.message}`);
  process.exitCode = 1;
}
