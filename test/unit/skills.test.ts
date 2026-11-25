import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { describe, expect, test } from "vitest";
import { readSkills, registerSkills } from "../../src/skills.js";

const SKILLS = new URL("../../skills/", import.meta.url).pathname;

/** A temporary `skills/` directory holding one file per entry. */
function fixture(files: Readonly<Record<string, string>>): string {
  const directory = mkdtempSync(join(tmpdir(), "bigquery-skills-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(directory, name), { recursive: true });
    writeFileSync(join(directory, name, "SKILL.md"), text);
  }
  return directory;
}

function withFixture<T>(files: Readonly<Record<string, string>>, run: (directory: string) => T): T {
  const directory = fixture(files);
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("skills", () => {
  test("every shipped skill is checked with its name, description and body", () => {
    const skills = readSkills();
    expect(skills.map((skill) => skill.id)).toEqual(["bigquery", "bigquery-sql"]);
    for (const skill of skills) {
      expect(skill.name).toBe(skill.id);
      expect(skill.description.trim()).not.toBe("");
      expect(skill.content.trim().length).toBeGreaterThan(0);
      expect(skill.path).toBe(join(SKILLS, skill.id, "SKILL.md"));
      expect(readFileSync(skill.path, "utf8")).toContain(skill.content.trim().split("\n")[0]!);
    }
  });

  test("YAML block scalars are folded, literal or stripped as YAML specifies", () => {
    const cases: readonly [string, string, string][] = [
      ["folded", ">", "first line second line\n"],
      ["literal", "|", "first line\nsecond line\n"],
      ["folded-strip", ">-", "first line second line"],
      ["literal-strip", "|-", "first line\nsecond line"],
    ];
    for (const [name, marker, expected] of cases) {
      withFixture({ [name]: `---\nname: ${name}\ndescription: ${marker}\n  first line\n  second line\n---\n\n# Body\n` }, (directory) => {
        expect(readSkills(directory)[0]?.description, name).toBe(expected);
      });
    }
  });

  test("a description that is only a block marker or empty is refused", () => {
    withFixture({ empty: "---\nname: empty\ndescription: >\n---\n\n# Body\n" }, (directory) => {
      expect(() => readSkills(directory)).toThrow(/has no frontmatter description/);
    });
    withFixture({ marker: "---\nname: marker\ndescription: '>'\n---\n\n# Body\n" }, (directory) => {
      expect(() => readSkills(directory)).toThrow(/only a block marker/);
    });
    withFixture({ broken: "---\nname: broken\ndescription: [unclosed\n---\n\n# Body\n" }, (directory) => {
      expect(() => readSkills(directory)).toThrow(/has frontmatter that is not valid YAML/);
    });
  });

  test("a skill file must have the frontmatter shape the plugin registers", () => {
    const cases: readonly [string, Readonly<Record<string, string>>, RegExp][] = [
      ["no frontmatter", { broken: "# Broken\n" }, /SCHEMA_VIOLATION: skills\/broken\/SKILL.md has no frontmatter\. Next step: /],
      ["no name", { broken: "---\ndescription: A description.\n---\n\n# Body\n" }, /has no frontmatter name/],
      ["another name", { broken: "---\nname: other\ndescription: A description.\n---\n\n# Body\n" }, /names "other", not its directory "broken"/],
      ["no description", { broken: "---\nname: broken\n---\n\n# Body\n" }, /has no frontmatter description/],
      ["empty content", { broken: "---\nname: broken\ndescription: A description.\n---\n\n" }, /has no content below its frontmatter/],
    ];
    for (const [name, files, expected] of cases) {
      withFixture(files, (directory) => {
        expect(() => readSkills(directory), name).toThrow(expected);
      });
    }
    withFixture({ empty: "" }, (directory) => {
      rmSync(join(directory, "empty", "SKILL.md"));
      expect(() => readSkills(directory)).toThrow(/skills\/empty\/SKILL.md is missing/);
    });
    const none = mkdtempSync(join(tmpdir(), "bigquery-skills-"));
    try {
      expect(() => readSkills(none)).toThrow(/holds no <name>\/SKILL\.md/);
    } finally {
      rmSync(none, { recursive: true, force: true });
    }
  });

  test("registerSkills adds every checked skill and returns a disposer", async () => {
    const added: { id: string; name: string; description: string; path: string; content: string }[] = [];
    let disposed = false;
    const context = {
      skill: {
        async transform(callback: (editor: { add: (skill: (typeof added)[number]) => void }) => void) {
          callback({ add: (skill) => added.push(skill) });
          return {
            async dispose() {
              disposed = true;
            },
          };
        },
      },
    } as unknown as Plugin.Context;
    const registration = await registerSkills(context);
    expect(added.map((skill) => skill.id)).toEqual(["bigquery", "bigquery-sql"]);
    expect(added.every((skill) => skill.description.trim() !== "" && skill.content !== "")).toBe(true);
    await registration.dispose();
    expect(disposed).toBe(true);
  });
});
