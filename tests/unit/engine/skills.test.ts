// tmb's own skills: each a procedure from skills/, named for tmb, with a one-line trigger.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SKILLS } from "../../../src/engine/index.ts";
import { REPO_ROOT } from "../../lib/paths.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const SKILLS_DIR = path.join(REPO_ROOT, "skills");

describe("tmb's own skills", () => {
  test("every file in skills/ is a listed skill, and every listed skill has its file", () => {
    const files = readdirSync(SKILLS_DIR).filter((name) => name.endsWith(".md")).sort();
    expect(SKILLS.map((skill) => `${skill.name}.md`).sort()).toEqual(files);
  });

  test("each skill is named tmb-…, has a one-line description and its prompt from skills/", () => {
    for (const skill of SKILLS) {
      expect(skill.name).toMatch(/^tmb-[a-z0-9-]+$/);
      expect(skill.description).not.toContain("\n");
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.prompt).toBe(readFileSync(path.join(SKILLS_DIR, `${skill.name}.md`), "utf8"));
    }
  });

  test("names are unique", () => {
    expect(new Set(SKILLS.map((skill) => skill.name)).size).toBe(SKILLS.length);
  });

  test("each skill the planner's role or a skill names is a listed skill, and the role names every skill", () => {
    const role = readFileSync(path.join(REPO_ROOT, "roles/planner.md"), "utf8");
    const namedIn = (text: string) => [...new Set(text.match(/\btmb-[a-z0-9-]+(?= skill)/g) ?? [])];
    const names = SKILLS.map((skill) => skill.name);
    for (const name of [role, ...SKILLS.map((skill) => skill.prompt)].flatMap(namedIn)) expect(names).toContain(name);
    expect(namedIn(role).sort()).toEqual([...names].sort());
  });
});
