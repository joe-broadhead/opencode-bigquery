// The repository's own checks, one stage after another (plugin standard §9). `plugin-kit check` owns the contract's
// conformance gate (T0, the declaration, the recorded sources and accounts, the bus, status, actions, grants, LD-5, and
// T1 on every tested host plus the first unsupported one), the doc file set, the forbidden scan and the bundled-kit
// check; this script runs it beside the repository's own lint, typecheck, build, unit and pack steps, which the kit does
// not run.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const STAGES = [
  { name: "lint", command: "npx", args: ["biome", "check", "."] },
  // The workflows as workflows: actionlint catches a `${{ }}` in a context GitHub rejects before any step runs.
  { name: "workflows", command: "node", args: ["scripts/actionlint.mjs"] },
  { name: "typecheck", command: "npx", args: ["tsc", "--noEmit"] },
  { name: "bundle", command: "npm", args: ["run", "bundle"] },
  { name: "unit", command: "npx", args: ["vitest", "run"] },
  { name: "docs", command: "npx", args: ["plugin-kit", "docs", "--check"] },
  { name: "conformance", command: "npx", args: ["plugin-kit", "check"] },
  { name: "pack", command: "node", args: ["scripts/pack.mjs"] },
];

const only = process.argv.slice(2);
const stages = only.length === 0 ? STAGES : STAGES.filter((stage) => only.includes(stage.name));
if (stages.length === 0) {
  console.error(`check: no stage named ${only.join(", ")}; the stages are ${STAGES.map((stage) => stage.name).join(", ")}`);
  process.exit(2);
}
for (const stage of stages) {
  process.stdout.write(`\n== ${stage.name}: ${stage.command} ${stage.args.join(" ")}\n`);
  const result = spawnSync(stage.command, stage.args, { cwd: root, stdio: "inherit", env: { ...process.env, NO_COLOR: "1" } });
  if (result.error) {
    console.error(`check: ${stage.name} did not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\ncheck: ${stage.name} failed (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}
console.log(`\ncheck: ok (${stages.length} stages: ${stages.map((stage) => stage.name).join(", ")})`);
