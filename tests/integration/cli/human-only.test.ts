// Steps only the Human may take run only on a terminal, once the Human types yes there
// (trustmybot/tmb#179). An agent's shell has no terminal: each such step run without one is
// refused, and the record holds no entry by the Human from it.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { openProjectStore } from "../../../src/engine/index.ts";
import { asHuman } from "../../lib/as-human.ts";
import { BASE_BRANCH, CLI, tmbProcesses } from "../../lib/tmb-processes.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const { scratch, env, git, run, tmb, human, setUpProject, cleanup, tool } = tmbProcesses("tmb-human-only-");
afterAll(cleanup);

/** Each file under the project, git's own objects aside, by a hash of its bytes. */
function snapshot(dir: string, base = dir): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const relative = path.relative(base, file);
    if (["objects", "logs", "index"].includes(name) && relative.startsWith(".git")) continue;
    // SQLite's shared-memory index changes whenever the record is opened, even only to read it.
    if (name.endsWith("-shm")) continue;
    if (statSync(file).isDirectory()) Object.assign(files, snapshot(file, base));
    else files[relative] = createHash("sha256").update(readFileSync(file)).digest("hex");
  }
  return files;
}

/** How many setting changes the record holds by the Human; the snapshot shows no other row changed either. */
function humanEntries(project: string): number {
  const opened = openProjectStore(project, { create: false });
  if (!opened.ok) throw opened.error;
  try {
    return opened.store.listSettingChanges().filter((entry) => entry.createdBy.kind === "human").length;
  } finally {
    opened.store.close();
  }
}

/** Each step, in the project whose home folder is named `name`. */
const steps = (name: string): { args: string[]; command: string }[] => [
  { args: ["feature", "waive", "feat/wave", "--reason", "an agent says it is fine"], command: "tmb feature waive" },
  { args: ["task", "waive", "T-1", "--reason", "an agent says it is fine"], command: "tmb task waive" },
  { args: ["onboard", "--review-mode", "truest", "--yes"], command: "tmb onboard --review-mode" },
  { args: ["onboard", "--review-mode=truest"], command: "tmb onboard --review-mode" },
  { args: ["remove", name], command: "tmb remove" },
  { args: ["remove", name, "--host", "claude-code"], command: "tmb remove" },
  { args: ["purge", name], command: "tmb purge" },
  { args: ["role", "grant", "worker", "task.drop"], command: "tmb role grant" },
  { args: ["role", "revoke", "planner", "task.waive"], command: "tmb role revoke" },
];

describe("a step only the Human may take", () => {
  test("with no terminal, each is refused and changes nothing, and the record holds no entry by the Human from it", () => {
    const project = setUpProject("true");
    tool(project, "feature_start", { name: "feat/wave" });
    const before = snapshot(project);
    const entries = humanEntries(project);
    for (const step of steps(path.basename(project))) {
      const result = run(step.args, project);
      expect({ args: step.args, status: result.status }).toEqual({ args: step.args, status: 1 });
      expect(result.stderr).toContain(`${step.command} is a step only the Human may take`);
      expect(result.stderr).toContain("There is no terminal here, so nothing was done.");
      expect(result.stdout).toBe("");
    }
    expect(snapshot(project)).toEqual(before);
    expect(humanEntries(project)).toBe(entries);
  }, 90_000);

  test("on a terminal, anything but yes refuses it and changes nothing; yes runs it", () => {
    const project = setUpProject("true");
    const before = snapshot(project);
    const refused = asHuman(process.execPath, [CLI, "onboard", "--review-mode", "truest"], { cwd: project, env, answers: ["y"] });
    expect(refused.status).toBe(1);
    expect(refused.output).toContain("Only the Human may set the review mode. Type yes to run tmb onboard --review-mode truest: ");
    expect(refused.output).toContain("tmb onboard --review-mode needs yes typed on the terminal; nothing was done.");
    expect(snapshot(project)).toEqual(before);

    expect(human(["onboard", "--review-mode", "truest", "--yes"], project)).toContain("Recorded 1 change in the record's setting changes.");
  }, 90_000);

  test("tmb role grant, on a terminal with yes, lets the worker drop a task; tmb role list marks it; a fixed step is refused", () => {
    const project = setUpProject("true");
    expect(human(["role", "grant", "worker", "task.drop"], project)).toContain("Granted task.drop to worker.");
    const listed = tmb(["role", "list"], project);
    expect(listed).toContain("worker  (changed)");
    expect(listed).toContain("+task.drop");
    expect(() => human(["role", "grant", "planner", "project.purge"], project)).toThrow("is the Human's alone");
  }, 90_000);

  test("with unattended mode on and no terminal, a run such as CI sets a review mode where none is set, never changes one, and lets nothing else through (trustmybot/tmb#223)", () => {
    const unattended = { ...env, TMB_UNATTENDED: "1" };
    const onboard = (project: string, ...args: string[]) => Bun.spawnSync([process.execPath, CLI, "onboard", ...args], { cwd: project, env: unattended });

    // A fresh project, as CI meets it: no review mode yet.
    const fresh = mkdtempSync(path.join(scratch, "fresh-"));
    git(fresh, "init", "-q", "-b", BASE_BRANCH);
    tmb(["init"], fresh);
    const set = onboard(fresh, "--base", BASE_BRANCH, "--review-mode", "truest", "--check", "true", "--yes");
    expect(set.exitCode).toBe(0);
    expect(set.stdout.toString()).toContain("review mode: truest");

    // Now one is set: the same run, or one in the project the Human chose agile for, changes nothing.
    for (const project of [fresh, setUpProject("true")]) {
      const before = snapshot(project);
      const entries = humanEntries(project);
      for (const args of [["--review-mode", "agile", "--yes"], ["--review-mode=agile"]]) {
        const changed = onboard(project, ...args);
        expect(changed.exitCode).toBe(1);
        expect(changed.stderr.toString()).toContain("unattended mode only sets one where none is set, so nothing was done");
        expect(changed.stdout.toString()).toBe("");
      }
      expect(snapshot(project)).toEqual(before);
      expect(humanEntries(project)).toBe(entries);
    }

    const removed = Bun.spawnSync([process.execPath, CLI, "remove", path.basename(fresh)], { cwd: fresh, env: unattended });
    expect(removed.exitCode).toBe(1);
    expect(removed.stderr.toString()).toContain("tmb remove is a step only the Human may take");
  }, 90_000);
});
