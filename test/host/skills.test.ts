// The skills proof on the real OpenCode 2.4.1 host: load the built bundle into the embedded `@opencode/sdk` host, prompt
// once so the plugin activates, and read the host's own skill list. Every `skills/<id>/SKILL.md` id must be there, with
// its path inside this package and its description and content filled in.
//
// The contract's `register` does not register skills, so this is the only proof that the package's skills load at all.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const ENTRY = join(REPO, "dist", "index.js");
const SKILLS = join(REPO, "skills");
const work = mkdtempSync(join(tmpdir(), "bigquery-skills-host-"));

afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A minimal real host: the built entry as the plugin, one session, one prompt to activate it. */
async function createHost() {
  if (!existsSync(ENTRY)) throw new Error("dist/index.js is missing: run `npm run bundle` before the host test");
  const { default: plugin } = (await import(pathToFileURL(ENTRY).href)) as { default: { id: string; setup: unknown } };
  const sdk = (await import(pathToFileURL(join(REPO, "node_modules", "@opencode", "sdk", "dist", "index.js")).href)) as typeof import("@opencode/sdk");
  const host = await sdk.OpenCode.create({
    plugins: [plugin as never],
    config: { directory: work },
    app: { name: "opencode", version: "2.4.1" },
    log: { level: "error", emit: () => undefined },
  });
  const session = await host.sessions.create({ location: { directory: work }, agent: "build", permissions: [] });
  await host.sessions.prompt({ sessionID: session.id, text: "activate the skills test", delivery: "queue" }).catch(() => undefined);
  return host;
}

/** One skill as the host lists it. */
interface HostSkill {
  readonly id: string;
  readonly path: string;
  readonly description?: string | null;
  readonly content: string;
}

/** Polls the host's skill list until every expected id is there, or the bound runs out. */
async function untilSkills(host: Awaited<ReturnType<typeof createHost>>, expected: readonly string[]): Promise<Map<string, HostSkill>> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const answer = (await host.skill.list({ location: { directory: work } }).catch(() => ({ data: [] }))) as { data: HostSkill[] };
    const found = new Map(answer.data.map((skill) => [skill.id, skill]));
    if (expected.every((id) => found.has(id))) return found;
    if (Date.now() > deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("skills on the real 2.4.1 host", () => {
  test("every skills/<id>/SKILL.md id is registered after load", async () => {
    const expected = readdirSync(SKILLS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(expected.length).toBeGreaterThan(0);
    const host = await createHost();
    try {
      const found = await untilSkills(host, expected);
      for (const id of expected) {
        const skill = found.get(id);
        expect(skill, `the host lists no skill ${id}`).toBeDefined();
        // Ours, not another package's skill of the same id: the path is this package's file, and it is filled in.
        expect(skill!.path).toBe(join(SKILLS, id, "SKILL.md"));
        expect(skill?.description ?? "").not.toBe("");
        expect(skill?.content ?? "").not.toBe("");
        expect(readFileSync(join(SKILLS, id, "SKILL.md"), "utf8")).toContain((skill?.content ?? "").trim().split("\n")[0] ?? "");
      }
    } finally {
      await host.close();
    }
  }, 120_000);
});
