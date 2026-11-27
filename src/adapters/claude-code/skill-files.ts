// Claude Code reads a project's skills from .claude/skills/<name>/SKILL.md. tmb writes one folder
// per skill of its own, marks the file as its own, and never touches a skill file it did not write.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Skill } from "../../engine/index.ts";
import { deleteFile } from "../common/json-file.ts";
import { isTmbFile, MARKER } from "./role-files.ts";

const SKILLS_RELATIVE = path.join(".claude", "skills");
const SKILL_FILE = "SKILL.md";
const SKILL_NAME = /^[a-z][a-z0-9-]*$/;

export function skillsDir(projectDir: string): string {
  return path.join(projectDir, SKILLS_RELATIVE);
}

export function skillFilePath(projectDir: string, skillName: string): string {
  return path.join(skillsDir(projectDir), skillName, SKILL_FILE);
}

/** The skill as a Claude Code skill file: frontmatter values as JSON strings, which YAML reads as quoted scalars. */
export function skillFileText(skill: Skill): string {
  return ["---", MARKER, `name: ${JSON.stringify(skill.name)}`, `description: ${JSON.stringify(skill.description)}`, "---", "", skill.prompt.trimEnd(), ""].join("\n");
}

/** Skill names in each outcome: written or rewritten, already current, or left alone because the file is not tmb's. */
export type SkillFilesResult = { written: string[]; current: string[]; notOurs: string[]; removed: string[] };

export function writeSkillFiles(projectDir: string, skills: readonly Skill[]): SkillFilesResult {
  const result: SkillFilesResult = { written: [], current: [], notOurs: [], removed: [] };
  for (const skill of skills) {
    if (!SKILL_NAME.test(skill.name)) throw new Error(`skill name ${JSON.stringify(skill.name)} must be lowercase letters, digits and hyphens`);
    const file = skillFilePath(projectDir, skill.name);
    const text = skillFileText(skill);
    if (existsSync(file)) {
      if (!isTmbFile(file)) {
        result.notOurs.push(skill.name);
        continue;
      }
      if (readFileSync(file, "utf8") === text) {
        result.current.push(skill.name);
        continue;
      }
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    result.written.push(skill.name);
  }
  // A skill file of tmb's for a skill this version no longer has goes, as tmb remove would take it.
  const wanted = new Set(skills.map((skill) => skillFilePath(projectDir, skill.name)));
  result.removed = removeSkillFiles(projectDir, (file) => !wanted.has(file));
  return result;
}

/** The skill file in each folder under the skills folder that tmb marked as its own. */
function tmbSkillFiles(projectDir: string): string[] {
  const dir = skillsDir(projectDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name, SKILL_FILE))
    .filter((file) => existsSync(file) && isTmbFile(file))
    .sort();
}

/**
 * Deletes every skill file tmb marked as its own, or those of them `only` keeps, with its folder
 * when that is left empty, and the skills folder when that is; returns their paths.
 */
export function removeSkillFiles(projectDir: string, only: (file: string) => boolean = () => true): string[] {
  const removed = tmbSkillFiles(projectDir).filter(only);
  for (const file of removed) deleteFile(file, projectDir);
  const dir = skillsDir(projectDir);
  if (removed.length > 0 && readdirSync(dir).length === 0) rmdirSync(dir);
  return removed;
}

/** What `tmb doctor` finds wrong with tmb's skill files: one line each, none when init would change nothing. Never writes. */
export function skillFileGaps(projectDir: string, skills: readonly Skill[]): string[] {
  const gaps: string[] = [];
  for (const skill of skills) {
    const file = skillFilePath(projectDir, skill.name);
    const shown = path.relative(projectDir, file);
    if (!existsSync(file)) gaps.push(`${shown} is missing: the ${skill.name} skill is not written`);
    else if (!isTmbFile(file)) gaps.push(`${shown} is not tmb's, so the ${skill.name} skill is not tmb's either; tmb leaves it alone`);
    else if (readFileSync(file, "utf8") !== skillFileText(skill)) gaps.push(`${shown} is not this version's ${skill.name} skill`);
  }
  const wanted = new Set(skills.map((skill) => skillFilePath(projectDir, skill.name)));
  for (const file of tmbSkillFiles(projectDir)) {
    if (!wanted.has(file)) gaps.push(`${path.relative(projectDir, file)} is tmb's skill file for a skill this version no longer has`);
  }
  return gaps;
}
