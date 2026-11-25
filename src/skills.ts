// The plugin's own skills. `register` wires the doors but not skills: this reads each `skills/<id>/SKILL.md`, checks its
// frontmatter, and registers it through `ctx.skill.transform` at setup. A skill that cannot be read refuses setup with a
// clear error, so a broken package never loads half its skills.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type Plugin, Skill } from "@opencode/plugin";

/** The skills this package ships: one directory under `skills/` each, with a `SKILL.md`. */
export const SKILL_IDS = ["bigquery", "bigquery-sql"] as const;

/** One skill, as its frontmatter and body read. */
export interface ParsedSkill {
  readonly name: string;
  readonly description: string;
  readonly content: string;
}

function invalid(message: string): Error {
  return new Error(`The plugin's skills could not be registered: ${message} Next step: fix the skill file and reinstall the plugin.`);
}

/** Parses the frontmatter strictly: `name` equal to the directory, a `description`, and a non-empty body. */
export function parseSkill(id: string, text: string): ParsedSkill {
  const source = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  if (!match) throw invalid(`skills/${id}/SKILL.md has no frontmatter block.`);
  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!field || fields.has(field[1]!)) throw invalid(`skills/${id}/SKILL.md has an invalid frontmatter line: ${line.slice(0, 80)}.`);
    fields.set(field[1]!, field[2]!.trim());
  }
  const name = fields.get("name");
  const description = fields.get("description");
  if (fields.size !== 2 || name !== id || description === undefined || description === "") {
    throw invalid(`skills/${id}/SKILL.md needs exactly a name equal to "${id}" and a description.`);
  }
  const content = match[2]!.trim();
  if (content === "") throw invalid(`skills/${id}/SKILL.md has no content.`);
  return { name, description, content: match[2]!.trimStart() };
}

/** The absolute path the host should show for a skill. */
export function skillPath(id: string): string {
  return fileURLToPath(new URL(`../skills/${id}/SKILL.md`, import.meta.url));
}

/** The part of the plugin context skill registration needs. */
type SkillContext = { readonly skill: Pick<Plugin.Context["skill"], "transform"> };

/** Register every shipped skill; the registration is disposed with the plugin. */
export async function registerSkills(ctx: SkillContext): Promise<{ dispose(): Promise<void> }> {
  const skills = await Promise.all(
    SKILL_IDS.map(async (id) => {
      const path = skillPath(id);
      const text = await readFile(path, "utf8").catch(() => {
        throw invalid(`skills/${id}/SKILL.md is missing or unreadable.`);
      });
      return { id, path, ...parseSkill(id, text) };
    }),
  );
  return ctx.skill.transform((editor) => {
    for (const skill of skills) {
      editor.add({
        id: Skill.ID.make(skill.id),
        name: Skill.Name.make(skill.name),
        description: skill.description,
        // The host brands absolute paths; this one comes from the package location.
        path: skill.path as Skill.Info["path"],
        content: skill.content,
      });
    }
  });
}
