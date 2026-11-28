import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { adapter, skillFiles } from "../../src/adapters/claude-code/index.ts";
import { skillFileText } from "../../src/adapters/claude-code/skill-files.ts";
import { type Skill, SKILLS } from "../../src/engine/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const FIXTURE: Skill = { name: "tmb-fixture", description: "For a test: when a test runs, with a colon", prompt: "# Fixture\n\nDo the step.\n" };
const OTHER: Skill = { name: "tmb-other", description: "Another", prompt: "Other." };
const BINARY = [path.join(tmpdir(), "tmb bin", "tmb")];

let project: string;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "tmb-skills-"));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function writeHumanSkill(name: string, text: string): string {
  const file = skillFiles.filePath(project, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

describe("skill files", () => {
  test("write each skill as SKILL.md in its own folder, with its name, description and procedure, marked as tmb's", () => {
    expect(skillFiles.write(project, [FIXTURE, OTHER])).toEqual({ written: ["tmb-fixture", "tmb-other"], current: [], notOurs: [], removed: [] });
    expect(skillFiles.filePath(project, "tmb-fixture")).toBe(path.join(project, ".claude", "skills", "tmb-fixture", "SKILL.md"));

    const text = readFileSync(skillFiles.filePath(project, "tmb-fixture"), "utf8");
    expect(text).toBe(skillFileText(FIXTURE));
    const [, frontmatter, body] = text.split(/^---$/m);
    expect(frontmatter).toContain("# Written by tmb init");
    expect(frontmatter).toContain('name: "tmb-fixture"');
    expect(frontmatter).toContain('description: "For a test: when a test runs, with a colon"');
    expect(body!.trim()).toBe(FIXTURE.prompt.trim());
  });

  test("a second write changes nothing, and a changed skill rewrites tmb's own file", () => {
    skillFiles.write(project, [FIXTURE]);
    expect(skillFiles.write(project, [FIXTURE])).toEqual({ written: [], current: ["tmb-fixture"], notOurs: [], removed: [] });

    const changed = { ...FIXTURE, prompt: "Changed." };
    expect(skillFiles.write(project, [changed]).written).toEqual(["tmb-fixture"]);
    expect(readFileSync(skillFiles.filePath(project, "tmb-fixture"), "utf8")).toBe(skillFileText(changed));
  });

  test("never overwrite or remove a skill file tmb did not write", () => {
    const human = "---\nname: tmb-fixture\ndescription: mine\n---\n\nThe Human's own skill.\n";
    const file = writeHumanSkill("tmb-fixture", human);
    expect(skillFiles.write(project, [FIXTURE])).toEqual({ written: [], current: [], notOurs: ["tmb-fixture"], removed: [] });
    expect(skillFiles.remove(project)).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(human);
  });

  test("a skill this version no longer has loses its file of tmb's, and a skill of the Human's stays", () => {
    const human = writeHumanSkill("helper", "---\nname: helper\ndescription: mine\n---\n\nHelp.\n");
    skillFiles.write(project, [FIXTURE, OTHER]);

    expect(skillFiles.write(project, [OTHER])).toEqual({ written: [], current: ["tmb-other"], notOurs: [], removed: [skillFiles.filePath(project, "tmb-fixture")] });
    expect(existsSync(path.dirname(skillFiles.filePath(project, "tmb-fixture")))).toBe(false);
    expect(existsSync(human)).toBe(true);
  });

  test("remove deletes only tmb's files and folders, and the skills folder once it is empty", () => {
    const human = writeHumanSkill("helper", "---\nname: helper\ndescription: mine\n---\n\nHelp.\n");
    skillFiles.write(project, [FIXTURE, OTHER]);

    expect(skillFiles.remove(project)).toEqual([skillFiles.filePath(project, "tmb-fixture"), skillFiles.filePath(project, "tmb-other")]);
    expect(readdirSync(skillFiles.dir(project))).toEqual(["helper"]);
    expect(existsSync(human)).toBe(true);

    rmSync(path.dirname(human), { recursive: true });
    skillFiles.write(project, [OTHER]);
    skillFiles.remove(project);
    expect(existsSync(skillFiles.dir(project))).toBe(false);
  });

  test("doctor names a missing, changed, foreign or left-over skill file, and nothing once init wrote them", () => {
    expect(skillFiles.gaps(project, [FIXTURE])).toEqual([`${path.join(".claude", "skills", "tmb-fixture", "SKILL.md")} is missing: the tmb-fixture skill is not written`]);
    skillFiles.write(project, [FIXTURE, OTHER]);
    expect(skillFiles.gaps(project, [FIXTURE, OTHER])).toEqual([]);
    expect(skillFiles.gaps(project, [{ ...FIXTURE, prompt: "New." }, OTHER])).toEqual([
      `${path.join(".claude", "skills", "tmb-fixture", "SKILL.md")} is not this version's tmb-fixture skill`,
    ]);
    expect(skillFiles.gaps(project, [FIXTURE])).toEqual([
      `${path.join(".claude", "skills", "tmb-other", "SKILL.md")} is tmb's skill file for a skill this version no longer has`,
    ]);
  });

  test("refuse a skill name that is not a plain folder name", () => {
    expect(() => skillFiles.write(project, [{ ...OTHER, name: "../escape" }])).toThrow(/skill name/);
  });
});

describe("adapter setup, doctor and remove with skills", () => {
  test("setup writes tmb's skills and says so, a second setup changes nothing, doctor finds no gap, and remove deletes them", () => {
    const human = writeHumanSkill("helper", "---\nname: helper\ndescription: mine\n---\n\nHelp.\n");
    const first = adapter.setup(project, BINARY);
    for (const skill of SKILLS) {
      expect(first).toContain(`Wrote the ${skill.name} skill to ${path.join(".claude", "skills", skill.name, "SKILL.md")}.`);
      expect(readFileSync(skillFiles.filePath(project, skill.name), "utf8")).toBe(skillFileText(skill));
    }
    expect(adapter.setup(project, BINARY).filter((line) => !/already|kept/.test(line))).toEqual([]);
    expect(adapter.wiringGaps!(project, BINARY)).toEqual([]);

    const removed = adapter.remove(project);
    for (const skill of SKILLS) expect(removed).toContain(`Removed tmb's skill file ${path.join(".claude", "skills", skill.name, "SKILL.md")}.`);
    expect(readdirSync(skillFiles.dir(project))).toEqual(["helper"]);
    expect(existsSync(human)).toBe(true);
  });

  test("remove leaves no .claude folder when only tmb's files were in it", () => {
    adapter.setup(project, BINARY);
    adapter.remove(project);
    expect(existsSync(path.join(project, ".claude"))).toBe(false);
  });
});
