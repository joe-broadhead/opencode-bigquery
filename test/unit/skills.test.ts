import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseSkill } from "../../src/skills.js";

const SKILLS = new URL("../../skills/", import.meta.url).pathname;

describe("skills", () => {
  test("every shipped skill parses, names its directory and has a description and content", () => {
    for (const id of readdirSync(SKILLS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
      const skill = parseSkill(id, readFileSync(join(SKILLS, id, "SKILL.md"), "utf8"));
      expect(skill.name).toBe(id);
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.content.trim().length).toBeGreaterThan(0);
    }
  });

  test("a name that is not the directory is refused", () => {
    expect(() => parseSkill("bigquery", "---\nname: other\ndescription: x\n---\nbody\n")).toThrow(/name equal to "bigquery"/);
  });

  test("a missing description is refused", () => {
    expect(() => parseSkill("bigquery", "---\nname: bigquery\n---\nbody\n")).toThrow(/name equal to "bigquery" and a description/);
  });

  test("empty content is refused", () => {
    expect(() => parseSkill("bigquery", "---\nname: bigquery\ndescription: x\n---\n \n")).toThrow(/has no content/);
  });

  test("a missing frontmatter block is refused", () => {
    expect(() => parseSkill("bigquery", "body only\n")).toThrow(/no frontmatter/);
  });

  test("a repeated frontmatter field is refused", () => {
    expect(() => parseSkill("bigquery", "---\nname: bigquery\nname: bigquery\ndescription: x\n---\nbody\n")).toThrow(/invalid frontmatter line/);
  });
});
