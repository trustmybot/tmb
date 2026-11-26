// `tmb init`, `tmb onboard` and `tmb remove` as separate processes, the way the Human runs them:
// init prepares a fresh project without a question and leaves its settings empty, the first
// session start tells the planner to apply the ones it recommends, onboard changes them as often
// as asked, and remove takes back what init added.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { callJson, callRefused, CLI, tmbProcesses } from "./tmb-processes.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const NO_INPUT_LIMIT_MS = 20_000;
const { scratch, env, git, run, tmb, human, sessionStart, connect, cleanup } = tmbProcesses("tmb-init-onboard-");

afterAll(cleanup);

/** A fresh git project on branch trunk with one commit and a bun package with a test script. */
function newProject(): string {
  const project = mkdtempSync(path.join(scratch, "project-"));
  git(project, "init", "-q", "-b", "trunk");
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "bun test" } }));
  writeFileSync(path.join(project, "bun.lock"), "");
  writeFileSync(path.join(project, "index.ts"), "export const one = 1;\n");
  git(project, "add", ".");
  git(project, "commit", "-q", "-m", "first");
  return project;
}

function config(project: string): Record<string, unknown> {
  return JSON.parse(tmb(["config", "--json"], project)) as Record<string, unknown>;
}

/** Every file under `dir` but git's objects, logs and index, with its content; folders end in /. */
function snapshot(dir: string, base = dir): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const relative = path.relative(base, file);
    if (["objects", "logs", "index", "ORIG_HEAD"].includes(name) && relative.startsWith(".git")) continue;
    if (statSync(file).isDirectory()) {
      files[`${relative}/`] = "";
      Object.assign(files, snapshot(file, base));
    } else {
      files[relative] = readFileSync(file, "utf8");
    }
  }
  return files;
}

const EMPTY = { base_branch: null, review_mode: null, checks: null, graph_links: null };

describe("tmb init", () => {
  test("prepares a fresh project with no question asked, and ends saying how the settings get filled and that the review mode is the Human's", async () => {
    const project = newProject();
    // stdin stays open and empty: an init that waited for an answer would never exit.
    const child = Bun.spawn([process.execPath, CLI, "init"], { cwd: project, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), NO_INPUT_LIMIT_MS);
    const status = await child.exited;
    clearTimeout(timer);
    const stdout = await new Response(child.stdout).text();
    expect(status).toBe(0);
    expect(stdout).toContain("Indexed the code graph of trunk");
    // Piped, so plain: no colour codes around the commands.
    expect(stdout.trimEnd().split("\n").slice(-5)).toEqual([
      "tmb is set up for Claude Code. Next:",
      "  1. Run `claude` in this folder.",
      "  2. Send `@bro`.",
      "The settings are still empty: base branch and checks; bro applies the ones it recommends. To set them yourself, run `tmb onboard`.",
      "No review mode is chosen yet: it is your choice, as it decides how many tokens the project uses. To choose it, bro asks you among its onboarding questions at the first session, or run `tmb onboard`; no task starts until it is set.",
    ]);
    expect(config(project)).toEqual({ host: "claude-code", host_roles: { "claude-code": "planner" }, ...EMPTY });
    for (const file of [".tmb/trajectory.db", ".mcp.json", ".claude/settings.local.json", ".claude/agents/worker.md", ".git/hooks/pre-push"]) {
      expect(existsSync(path.join(project, file))).toBe(true);
    }
  });

  test("the reviewer's agent file takes away exactly the three editing tools, and the worker's takes away none", () => {
    const project = newProject();
    expect(run(["init"], project).status).toBe(0);
    const frontmatter = (role: string) => readFileSync(path.join(project, ".claude", "agents", `${role}.md`), "utf8").split(/^---$/m)[1]!;
    const denied = (role: string) => {
      const line = /^disallowedTools: (.*)$/m.exec(frontmatter(role));
      return line ? (JSON.parse(line[1]!) as string).split(", ") : [];
    };
    expect(denied("reviewer")).toEqual(["Edit", "Write", "NotebookEdit"]);
    expect(denied("worker")).toEqual([]);
    for (const role of ["reviewer", "worker"]) expect(frontmatter(role)).not.toMatch(/^tools:/m);
  });

  test("in a folder with no repo, runs git init first, so its own files are ignored on the first run (trustmybot/tmb#180)", () => {
    const project = mkdtempSync(path.join(scratch, "bare-"));
    writeFileSync(path.join(project, "notes.md"), "# notes\n");
    expect(tmb(["init"], project)).toContain("so tmb ran git init in it");
    const status = git(project, "status", "--porcelain", "--untracked-files=all");
    expect(status).toContain("notes.md");
    expect(status).not.toContain(".tmb/");
    expect(status).not.toContain(".mcp.json");
    expect(status).not.toContain("settings.local.json");
  });

  test("takes only the host and its role", () => {
    for (const flag of ["--yes", "--base"]) {
      const result = run(["init", flag, ...(flag === "--base" ? ["main"] : [])], newProject());
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(flag);
    }
  });
});

describe("onboarding at the first session", () => {
  test("the planner is told the settings are empty, and applies its recommendation through settings_set", async () => {
    const project = newProject();
    tmb(["init"], project);
    const context = sessionStart(project);
    expect(context).toContain("## The project's settings are empty");
    expect(context).toContain("- base branch: `trunk`");
    expect(context).toContain("- checks: `bun run test`");
    expect(context).toContain("`tmb onboard` can be run again at any time");

    const client = await connect(project);
    try {
      const set = await callJson(client, "settings_set", { base_branch: "trunk", review_mode: "agile", checks: ["bun run test"], graph_links: null });
      expect(set.empty).toEqual([]);
    } finally {
      await client.close();
    }
    expect(config(project)).toEqual({ host: "claude-code", host_roles: { "claude-code": "planner" }, base_branch: "trunk", review_mode: "agile", checks: ["bun run test"], graph_links: null });
    expect(sessionStart(project)).not.toContain("## The project's settings are empty");
  });
});

describe("the review mode is the Human's choice (trustmybot/tmb#114)", () => {
  test("no task starts until it is chosen; in an unattended run the planner cannot choose it, and the Human's tmb onboard --review-mode --yes can", async () => {
    const project = newProject();
    tmb(["init"], project);
    tmb(["onboard", "--base", "trunk", "--check", "true", "--yes"], project);
    expect(config(project).review_mode).toBeNull();

    const client = await connect(project, "test", { unattended: true });
    try {
      const issue = await callJson(client, "issue_create", { title: "A goal" });
      await callJson(client, "feature_start", { name: "feat/goal" });
      const spec = { issue_id: issue.id, kind: "code", intent: "Do it", files: ["a.txt"], criteria: ["SC1: done"] };
      expect(await callRefused(client, "task_start", spec)).toContain("`tmb onboard`");
      expect(await callRefused(client, "settings_set", { review_mode: "agile" })).toContain("no one can answer in this run");
      expect(config(project).review_mode).toBeNull();

      human(["onboard", "--review-mode", "agile", "--yes"], project);
      expect((await callJson(client, "task_start", spec)).brief).toMatchObject({ state: "open", feature: "feat/goal" });
    } finally {
      await client.close();
    }
  });
});

describe("tmb onboard", () => {
  test("refuses a project init has not prepared, and writes nothing", () => {
    const project = newProject();
    const before = snapshot(project);
    const result = run(["onboard", "--base", "main"], project);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tmb is not set up in this project; run tmb init first");
    expect(snapshot(project)).toEqual(before);
  });

  test("changes a setting, and can be run again to change another", () => {
    const project = newProject();
    tmb(["init"], project);
    expect(tmb(["onboard", "--base", "release"], project)).toContain("Recorded 2 changes in the record's audit trail.");
    expect(config(project)).toMatchObject({ base_branch: "release", review_mode: null, checks: ["bun run test"] });
    expect(human(["onboard", "--review-mode", "truest", "--role", "reviewer", "--yes"], project)).toContain("Recorded 2 changes in the record's audit trail.");
    expect(config(project)).toEqual({ host: "claude-code", host_roles: { "claude-code": "reviewer" }, base_branch: "release", review_mode: "truest", checks: ["bun run test"], graph_links: null });
    expect(tmb(["onboard"], project)).toContain("No setting changed, so nothing was recorded.");
  }, 30_000);
});

describe("tmb remove", () => {
  test("undoes what init added, keeping the record and the .gitignore lines", () => {
    const project = newProject();
    const before = snapshot(project);
    tmb(["init"], project);
    expect(snapshot(project)).not.toEqual(before);
    human(["remove"], project);
    const after = snapshot(project);
    // The record is the Human's data, and remove never edits .gitignore.
    for (const kept of Object.keys(after).filter((file) => file === ".gitignore" || file.startsWith(".tmb"))) delete after[kept];
    expect(after).toEqual(before);
  });
});

describe("tmb setup", () => {
  test("is gone: it is refused as an unknown command, and writes nothing", () => {
    const project = newProject();
    const before = snapshot(project);
    const result = run(["setup", "--yes"], project);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("setup");
    expect(snapshot(project)).toEqual(before);
  });
});
