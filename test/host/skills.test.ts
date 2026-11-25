// The real-host surface proof on OpenCode 2.4.1: load the built bundle into the embedded `@opencode/sdk` host, prompt
// once so the plugin activates, and read what the host itself reports.
//
// The contract's `register` does not register skills, so the skills test is the only proof that `skills/*/SKILL.md`
// loads. The parity test records the tools and commands the plugin registers and reads the host's skill, command,
// integration and agent lists, so the new surface can be compared with the last pre-4b release.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { manifest } from "../../src/manifest.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const ENTRY = join(REPO, "dist", "index.js");
const SKILLS = join(REPO, "skills");
const work = mkdtempSync(join(tmpdir(), "bigquery-host-"));

afterAll(() => rmSync(work, { recursive: true, force: true }));

/** One skill as the host lists it. */
interface HostSkill {
  readonly id: string;
  readonly path: string;
  readonly description?: string | null;
  readonly content: string;
}

/** One tool the plugin registered, through a proxy on `ctx.tool.transform`. */
interface RecordedTool {
  readonly name: string;
  readonly namespace: string;
  readonly permission: string;
}

/** What the plugin did through the real context. */
interface Recorded {
  readonly tools: RecordedTool[];
  readonly commands: string[];
  namespace: string;
}

/**
 * A minimal real host: the built entry as the plugin, wrapped so its tool and command registrations are recorded, one
 * session, and one prompt to activate it. Everything else is the host's own context.
 */
async function createHost() {
  if (!existsSync(ENTRY)) throw new Error("dist/index.js is missing: run `npm run bundle` before the host test");
  const { default: plugin } = (await import(pathToFileURL(ENTRY).href)) as { default: { id: string; setup: (context: unknown) => unknown } };
  const recorded: Recorded = { tools: [], commands: [], namespace: "" };
  const wrapper = {
    id: plugin.id,
    setup: async (context: unknown) => {
      const real = context as Record<string, unknown>;
      const toolDomain = real["tool"] as { transform(callback: (editor: unknown) => void): Promise<unknown> };
      const commandDomain = real["command"] as { transform(callback: (editor: unknown) => void): Promise<unknown> };
      const tool = new Proxy(toolDomain, {
        get(target, field) {
          if (field !== "transform") return Reflect.get(target, field);
          return (callback: (editor: unknown) => void) =>
            target.transform((editor: unknown) => {
              const proxied = new Proxy(editor as Record<string, unknown>, {
                get(editorTarget, editorField) {
                  if (editorField === "namespace") {
                    return (value: { name: string }) => {
                      recorded.namespace = value.name;
                      return (editorTarget["namespace"] as (value: unknown) => unknown)(value);
                    };
                  }
                  if (editorField === "add") {
                    return (registration: { name: string; options?: { permission?: string } }) => {
                      // A rebuild replays the transform: keep one entry per tool, so a duplicate is not counted twice.
                      const entry = { name: registration.name, namespace: recorded.namespace, permission: registration.options?.permission ?? "" };
                      const at = recorded.tools.findIndex((tool) => tool.name === entry.name);
                      if (at === -1) recorded.tools.push(entry);
                      else recorded.tools[at] = entry;
                      return (editorTarget["add"] as (value: unknown) => unknown)(registration);
                    };
                  }
                  const value = Reflect.get(editorTarget, editorField);
                  return typeof value === "function" ? value.bind(editorTarget) : value;
                },
              });
              return callback(proxied);
            });
        },
      });
      const command = new Proxy(commandDomain, {
        get(target, field) {
          if (field !== "transform") return Reflect.get(target, field);
          return (callback: (editor: unknown) => void) =>
            target.transform((editor: unknown) => {
              const proxied = new Proxy(editor as Record<string, unknown>, {
                get(editorTarget, editorField) {
                  if (editorField === "add") {
                    return (definition: { name: string }) => {
                      if (!recorded.commands.includes(definition.name)) recorded.commands.push(definition.name);
                      return (editorTarget["add"] as (value: unknown) => unknown)(definition);
                    };
                  }
                  const value = Reflect.get(editorTarget, editorField);
                  return typeof value === "function" ? value.bind(editorTarget) : value;
                },
              });
              return callback(proxied);
            });
        },
      });
      const proxy = new Proxy(real, {
        get(target, property) {
          if (property === "tool") return tool;
          if (property === "command") return command;
          return Reflect.get(target, property);
        },
      });
      return plugin.setup(proxy);
    },
  };
  const sdk = (await import(pathToFileURL(join(REPO, "node_modules", "@opencode", "sdk", "dist", "index.js")).href)) as typeof import("@opencode/sdk");
  const host = await sdk.OpenCode.create({
    plugins: [wrapper as never],
    config: { directory: work },
    app: { name: "opencode", version: "2.4.1" },
    log: { level: "error", emit: () => undefined },
  });
  const session = await host.sessions.create({ location: { directory: work }, agent: "build", permissions: [] });
  await host.sessions.prompt({ sessionID: session.id, text: "activate the host tests", delivery: "queue" }).catch(() => undefined);
  return { host, session, recorded };
}

/** Polls the host's skill list until every expected id is there, or the bound runs out. */
async function untilSkills(host: Awaited<ReturnType<typeof createHost>>["host"], expected: readonly string[]): Promise<Map<string, HostSkill>> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const answer = (await host.skill.list({ location: { directory: work } }).catch(() => ({ data: [] }))) as { data: HostSkill[] };
    const found = new Map(answer.data.map((skill) => [skill.id, skill]));
    if (expected.every((id) => found.has(id))) return found;
    if (Date.now() > deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function skillDirectories(): string[] {
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe("the built plugin on the real 2.4.1 host", () => {
  test("every skills/<id>/SKILL.md id is registered after load", async () => {
    const expected = skillDirectories();
    expect(expected.length).toBeGreaterThan(0);
    const { host } = await createHost();
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

  test("parity: every method is a tool, both skills load, no old command or custom agent remains, and status answers", async () => {
    const { host, session, recorded } = await createHost();
    try {
      await untilSkills(host, skillDirectories());
      const methods = Object.keys(manifest.methods)
        .filter((method) => !method.startsWith("mcp:"))
        .sort();
      expect(recorded.namespace).toBe("bigquery");
      expect(recorded.tools.map((tool) => tool.name).sort()).toEqual(methods);
      for (const tool of recorded.tools) expect(tool.permission).toBe(`bigquery.${tool.name}`);

      const skills = (await host.skill.list({ location: { directory: work } })) as { data: HostSkill[] };
      for (const id of skillDirectories()) expect(skills.data.map((skill) => skill.id)).toContain(id);
      const listed = skills.data.filter((skill) => skillDirectories().includes(skill.id));
      expect(listed.map((skill) => skill.id).sort()).toEqual(skillDirectories());

      // The old `/bigquery-status`, `/bigquery-doctor`, `/bigquery-signout` and the TUI `/bigquery` are gone on purpose
      // (CHANGELOG "Removed since …"); the plugin registers no command, and the host lists none in its namespace.
      expect(recorded.commands).toEqual([]);
      const commands = (await host.command.list({ location: { directory: work } })) as { data: { name: string }[] };
      expect(commands.data.filter((command) => command.name.startsWith("bigquery")).map((command) => command.name)).toEqual([]);

      // No custom agent: the old plugin registered access rules into the built-in agents, not agents of its own.
      const agents = (await host.agent.list({ location: { directory: work } })) as { data: { id: string }[] };
      expect(agents.data.filter((agent) => agent.id === "bigquery" || agent.id.startsWith("bigquery-")).map((agent) => agent.id)).toEqual([]);

      // One integration for the default alias, named `bigquery`, holding an OAuth method: the sign-in parity row.
      const integrations = (await host.integration.list({ location: { directory: work } })) as { data: { id: string; methods: { type: string }[] }[] };
      const own = integrations.data.find((integration) => integration.id === "bigquery");
      expect(own).toBeDefined();
      expect(own?.methods.some((method) => method.type === "oauth")).toBe(true);

      // Status answers over RPC under the session, as the old status tool did.
      const answer = (await host.rpc.call({
        rpcID: "bigquery",
        method: "status",
        input: { sessionID: session.id, input: {} },
        location: { directory: work },
      }).catch((error: unknown) => ({ output: undefined, error }))) as { output?: { name?: string; accounts?: { alias: string }[] } };
      expect(answer.output?.name).toBe("bigquery");
      expect(answer.output?.accounts?.map((account) => account.alias)).toEqual(["default"]);
    } finally {
      await host.close();
    }
  }, 120_000);
});
