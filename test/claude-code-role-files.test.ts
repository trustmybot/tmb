import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { adapter } from "../src/adapters/claude-code/index.ts";
import { agentsDir, removeRoleFiles, roleFilePath, roleFileText, writeRoleFiles } from "../src/adapters/claude-code/role-files.ts";
import { settingsPath } from "../src/adapters/claude-code/settings.ts";
import type { SubagentRole } from "../src/engine/index.ts";

const FIXTURE: SubagentRole = {
  name: "fixture-worker",
  description: "Implements one spec: a test role, with a colon",
  prompt: "# You are the fixture worker\n\nDo the task.\n",
  capabilities: ["read-files", "edit-files", "run-commands"],
  model: "sonnet",
  effort: "high",
};
const PLAIN: SubagentRole = { name: "plain", description: "No model or effort", prompt: "Plain prompt.", capabilities: ["read-files"] };
const BINARY = [path.join(tmpdir(), "tmb bin", "tmb")];

let project: string;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "tmb-roles-"));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

/** The deny list in an agent file's frontmatter, one name per item; none when the file has no deny list. */
function deniedIn(agentFileText: string): string[] {
  const frontmatter = agentFileText.split(/^---$/m)[1]!;
  expect(frontmatter).not.toMatch(/^tools:/m);
  const line = /^disallowedTools: (.*)$/m.exec(frontmatter);
  return line ? (JSON.parse(line[1]!) as string).split(", ") : [];
}

function writeHumanAgent(name: string, text: string): string {
  const file = roleFilePath(project, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

describe("role files", () => {
  test("write each role as a Claude Code agent file with its frontmatter and prompt, marked as tmb's", () => {
    expect(writeRoleFiles(project, [FIXTURE, PLAIN])).toEqual({ written: ["fixture-worker", "plain"], current: [], notOurs: [], removed: [] });

    const text = readFileSync(roleFilePath(project, "fixture-worker"), "utf8");
    expect(text).toBe(roleFileText(FIXTURE));
    const [, frontmatter, body] = text.split(/^---$/m);
    expect(frontmatter).toContain("# Written by tmb init");
    expect(frontmatter).toContain('name: "fixture-worker"');
    expect(frontmatter).toContain('description: "Implements one spec: a test role, with a colon"');
    expect(frontmatter).toContain('model: "sonnet"');
    expect(frontmatter).toContain('effort: "high"');
    expect(body!.trim()).toBe(FIXTURE.prompt.trim());

    const plain = readFileSync(roleFilePath(project, "plain"), "utf8");
    expect(plain).not.toContain("model:");
    expect(plain).not.toContain("effort:");
  });

  test("the deny list holds the host tools of the capabilities the role lacks, and a role that lacks none has no tool list at all", () => {
    expect(deniedIn(roleFileText(FIXTURE))).toEqual([]);
    expect(roleFileText(FIXTURE)).not.toContain("disallowedTools");
    expect(deniedIn(roleFileText(PLAIN))).toEqual(["Edit", "Write", "NotebookEdit", "Bash"]);
  });

  test("a second write changes nothing, and a changed role rewrites tmb's own file", () => {
    writeRoleFiles(project, [FIXTURE]);
    expect(writeRoleFiles(project, [FIXTURE])).toEqual({ written: [], current: ["fixture-worker"], notOurs: [], removed: [] });

    const changed = { ...FIXTURE, model: "opus" };
    expect(writeRoleFiles(project, [changed]).written).toEqual(["fixture-worker"]);
    expect(readFileSync(roleFilePath(project, "fixture-worker"), "utf8")).toBe(roleFileText(changed));
  });

  test("never overwrite an agent file tmb did not write", () => {
    const human = "---\nname: fixture-worker\ndescription: mine\n---\n\nThe Human's own agent.\n";
    const file = writeHumanAgent("fixture-worker", human);
    expect(writeRoleFiles(project, [FIXTURE])).toEqual({ written: [], current: [], notOurs: ["fixture-worker"], removed: [] });
    expect(readFileSync(file, "utf8")).toBe(human);
  });

  test("a role this version no longer has loses its file of tmb's, and a file of the Human's stays", () => {
    const human = writeHumanAgent("helper", "---\nname: helper\ndescription: mine\n---\n\nHelp.\n");
    writeRoleFiles(project, [FIXTURE, PLAIN]);

    expect(writeRoleFiles(project, [PLAIN])).toEqual({ written: [], current: ["plain"], notOurs: [], removed: [roleFilePath(project, "fixture-worker")] });
    expect(existsSync(roleFilePath(project, "fixture-worker"))).toBe(false);
    expect(existsSync(human)).toBe(true);
    expect(writeRoleFiles(project, [PLAIN]).removed).toEqual([]);
  });

  test("remove deletes only tmb's files, and the folder once it is empty", () => {
    const human = writeHumanAgent("helper", "---\nname: helper\ndescription: mine\n---\n\nHelp.\n");
    writeRoleFiles(project, [FIXTURE, PLAIN]);

    expect(removeRoleFiles(project)).toEqual([roleFilePath(project, "fixture-worker"), roleFilePath(project, "plain")]);
    expect(existsSync(human)).toBe(true);
    expect(removeRoleFiles(project)).toEqual([]);

    rmSync(human);
    writeRoleFiles(project, [PLAIN]);
    removeRoleFiles(project);
    expect(existsSync(agentsDir(project))).toBe(false);
  });

  test("recognise a file an earlier build marked as written by tmb setup: init replaces it and remove deletes it", () => {
    mkdirSync(agentsDir(project), { recursive: true });
    const earlier = roleFileText(PLAIN).replace("# Written by tmb init and deleted by tmb remove; tmb init replaces any edit.", "# Written by tmb setup and deleted by tmb remove; tmb setup replaces any edit.");
    expect(earlier).not.toBe(roleFileText(PLAIN));
    writeFileSync(roleFilePath(project, "plain"), earlier);
    expect(writeRoleFiles(project, [PLAIN])).toEqual({ written: ["plain"], current: [], notOurs: [], removed: [] });
    expect(readFileSync(roleFilePath(project, "plain"), "utf8")).toBe(roleFileText(PLAIN));
    writeFileSync(roleFilePath(project, "plain"), earlier);
    removeRoleFiles(project);
    expect(existsSync(agentsDir(project))).toBe(false);
  });

  test("refuse a role name that is not a plain file name", () => {
    expect(() => writeRoleFiles(project, [{ ...PLAIN, name: "../escape" }])).toThrow(/role name/);
  });
});

describe("adapter setup and remove with roles", () => {
  test("setup writes the given roles, says so, and changes nothing the second time; remove deletes them", () => {
    const first = adapter.setup(project, BINARY, [FIXTURE]);
    expect(first).toContain(`Wrote the fixture-worker role to ${path.join(".claude", "agents", "fixture-worker.md")}.`);
    const text = readFileSync(roleFilePath(project, "fixture-worker"), "utf8");

    const second = adapter.setup(project, BINARY, [FIXTURE]);
    expect(second.every((line) => /already|kept/.test(line))).toBe(true);
    expect(readFileSync(roleFilePath(project, "fixture-worker"), "utf8")).toBe(text);

    const removed = adapter.remove(project);
    expect(removed).toContain(`Removed tmb's role file ${path.join(".claude", "agents", "fixture-worker.md")}.`);
    expect(existsSync(settingsPath(project))).toBe(false);
    expect(existsSync(path.join(project, ".claude"))).toBe(false);
  });

  test("setup keeps the Human's agent file of the same name and says the role was not written", () => {
    const file = writeHumanAgent("fixture-worker", "The Human's own.\n");
    const lines = adapter.setup(project, BINARY, [FIXTURE]);
    expect(lines.some((line) => line.includes("is not tmb's"))).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("The Human's own.\n");
    adapter.remove(project);
    expect(readFileSync(file, "utf8")).toBe("The Human's own.\n");
  });

  test("setup with the engine's list writes the worker in a worktree of its own and the reviewer denied the file-editing tools", () => {
    const helper = writeHumanAgent("helper", "---\nname: helper\ndescription: mine\n---\n\nHelp.\n");
    adapter.setup(project, BINARY);
    expect(readdirSync(agentsDir(project)).sort()).toEqual(["helper.md", "reviewer.md", "worker.md"]);

    const worker = readFileSync(roleFilePath(project, "worker"), "utf8");
    const reviewer = readFileSync(roleFilePath(project, "reviewer"), "utf8");
    expect(worker).toContain('name: "worker"');
    expect(reviewer).toContain('name: "reviewer"');
    expect(worker).toContain("# You are a worker");
    expect(reviewer).toContain("# You are the reviewer");

    expect(deniedIn(worker)).toEqual([]);
    expect(deniedIn(reviewer)).toEqual(["Edit", "Write", "NotebookEdit"]);
    expect(worker).toMatch(/^isolation: "worktree"$/m);
    expect(reviewer).not.toContain("isolation");

    expect(adapter.setup(project, BINARY).filter((line) => !/already|kept/.test(line))).toEqual([]);
    expect(readFileSync(roleFilePath(project, "worker"), "utf8")).toBe(worker);
    expect(readFileSync(roleFilePath(project, "reviewer"), "utf8")).toBe(reviewer);

    expect(adapter.remove(project)).toEqual(
      expect.arrayContaining([
        `Removed tmb's role file ${path.join(".claude", "agents", "reviewer.md")}.`,
        `Removed tmb's role file ${path.join(".claude", "agents", "worker.md")}.`,
      ]),
    );
    expect(readdirSync(agentsDir(project))).toEqual(["helper.md"]);
    expect(readFileSync(helper, "utf8")).toBe("---\nname: helper\ndescription: mine\n---\n\nHelp.\n");
  });
});
