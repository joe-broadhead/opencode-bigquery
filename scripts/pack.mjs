// The pack stage: what `npm pack` would publish is the package a tag installs, so it must carry the built entry, the
// skills, the assets, the README and the licence, and nothing else. `files` in package.json decides that list; this
// check proves the tarball matches it, declares no runtime dependency or lifecycle script, and carries a manifest the
// contract validates.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readInstalledManifest } from "@we-the-rebel-alliance/plugin-contract/manifest";

const root = fileURLToPath(new URL("../", import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), "bigquery-pack-"));
const problems = [];
try {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  mkdirSync(join(workspace, "tarball"), { recursive: true });
  const packed = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", join(workspace, "tarball")], { cwd: root, encoding: "utf8" });
  const [entry] = JSON.parse(packed);
  const files = entry.files.map((file) => file.path).sort();
  const expected = ["LICENSE", "README.md", "assets/icon-128.png", "assets/icon-256.png", "assets/icon.svg", "dist/index.js", "package.json", "skills/bigquery/SKILL.md", "skills/bigquery-sql/SKILL.md"].sort();
  const missing = expected.filter((path) => !files.includes(path));
  const unexpected = files.filter((path) => !expected.includes(path));
  for (const path of missing) problems.push(`the tarball is missing ${path}`);
  for (const path of unexpected) problems.push(`the tarball carries ${path}, which package.json files does not ship`);
  if (pkg.dependencies !== undefined || pkg.peerDependencies !== undefined) problems.push("package.json declares a runtime or peer dependency; the bundle is self-contained");
  for (const script of ["preinstall", "install", "postinstall", "prepare", "prepack"]) if (pkg.scripts?.[script] !== undefined) problems.push(`package.json declares the ${script} lifecycle script`);
  const installed = readInstalledManifest(root, { version: pkg.version });
  if (!installed.ok) problems.push(...installed.problems);
  if (installed.ok && installed.value.manifest.plugin.name !== "bigquery") problems.push(`the manifest names ${installed.value.manifest.plugin.name}, not bigquery`);
  console.log(`pack: ${entry.filename} (${entry.size} bytes, ${files.length} files)`);
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
if (problems.length > 0) {
  for (const problem of problems) console.error(`pack: ${problem}`);
  process.exit(1);
}
console.log("pack: ok");
