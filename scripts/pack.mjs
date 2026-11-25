// The pack stage: what `npm pack` would publish is the package a tag installs, so it must carry the built entry, the
// skills and the assets, declare no runtime dependency and no lifecycle script, and carry a capabilities manifest the
// contract validates. The tarball's file list is compared with package.json's `files`; nothing else may slip in.
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
  const required = ["package.json", "dist/index.js", "skills/bigquery/SKILL.md", "skills/bigquery-sql/SKILL.md", "assets/icon.svg", "README.md", "LICENSE", "CHANGELOG.md", "NOTICE"];
  for (const path of required) if (!files.includes(path)) problems.push(`the tarball is missing ${path}`);
  for (const path of files) {
    if (path.startsWith("test/") || path.startsWith("scripts/") || path.startsWith("reports/") || path.startsWith(".github/")) problems.push(`the tarball carries ${path}, which is not published`);
  }
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
