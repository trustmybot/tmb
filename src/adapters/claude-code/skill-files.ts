// Claude Code reads a project's skills from .claude/skills/<name>/SKILL.md. tmb writes one folder
// per skill of its own, marks the file as its own, and never touches a skill file it did not write.
import { existsSync, readdirSync, rmdirSync } from "node:fs";
import path from "node:path";
import type { Skill } from "../../engine/index.ts";
import { MarkedFiles } from "../common/marked-files.ts";
import { FILES, MARKERS } from "./host.ts";
import { isTmbFile } from "./role-files.ts";

/** The skill as a Claude Code skill file: frontmatter values as JSON strings, which YAML reads as quoted scalars. */
export function skillFileText(skill: Skill): string {
  return ["---", MARKERS.current, `name: ${JSON.stringify(skill.name)}`, `description: ${JSON.stringify(skill.description)}`, "---", "", skill.prompt.trimEnd(), ""].join("\n");
}

/** tmb's skill files in the project's .claude/skills. */
export class SkillFiles extends MarkedFiles<Skill> {
  constructor() {
    super("skill");
  }

  dir(projectDir: string): string {
    return path.join(projectDir, FILES.skillsDir);
  }

  filePath(projectDir: string, skillName: string): string {
    return path.join(this.dir(projectDir), skillName, FILES.skillFile);
  }

  protected override textOf(): (skill: Skill) => string {
    return skillFileText;
  }

  protected override isOurs(file: string): boolean {
    return isTmbFile(file);
  }

  /** The skill file in each folder under the skills folder that tmb marked as its own. */
  protected override ownedFiles(projectDir: string, only: (file: string) => boolean): string[] {
    const dir = this.dir(projectDir);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name, FILES.skillFile))
      .filter((file) => existsSync(file) && isTmbFile(file))
      .sort()
      .filter(only);
  }

  /** Each skill's folder went with its file when left empty; the skills folder goes too when it is. */
  protected override afterRemove(projectDir: string, removed: readonly string[]): void {
    const dir = this.dir(projectDir);
    if (removed.length > 0 && readdirSync(dir).length === 0) rmdirSync(dir);
  }
}
