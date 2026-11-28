// trustmybot/tmb#160: `tmb doctor` checks the machine and the project, reads only, and with
// `--fix` does each fix the Human says yes to. Each check here is broken once and found.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { adapter as claudeCode, roleFiles } from "../../../src/adapters/claude-code/index.ts";
import { adapter as codex } from "../../../src/adapters/codex/index.ts";
import { HOST_ADAPTERS } from "../../../src/adapters/index.ts";
import { exitCode, findingsJson, formatFindings, runChecks, runDoctorCommand, sessionStartLine } from "../../../src/cli/commands/doctor/index.ts";
import type { DoctorEnv, Finding } from "../../../src/cli/commands/doctor/types.ts";
import { buildLayer } from "../../../src/engine/graph/build.ts";
import { BASE_LAYER, openGraphDb } from "../../../src/engine/graph/db.ts";
import { indexProject } from "../../../src/engine/graph/fresh.ts";
import { HandlerError } from "../../../src/engine/handlers/index.ts";
import { baseCommit } from "../../../src/engine/graph/git-source.ts";
import { DOCTOR_HEADING, handleEvent, installPushGate, openProjectStore, projectDbPath, tieProgram, writeSetting } from "../../../src/engine/index.ts";
import type { Actor, Store } from "../../../src/engine/store/index.ts";
import { git } from "../../lib/git.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "claude-code" };
const VERSION = "1.2.0";

let root: string;
let project: string;
let stateDir: string;
let binDir: string;
const savedEnv = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };

function withStore<T>(dir: string, use: (store: Store) => T): T {
  const opened = openProjectStore(dir, { create: true });
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    return use(opened.store);
  } finally {
    opened.store.close();
  }
}

/** A healthy project: a commit on main, wired for Claude Code, tied, every setting set, and indexed. */
async function healthyProject(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  writeFileSync(path.join(dir, "a.ts"), "export function a(): number { return 1; }\n");
  writeFileSync(path.join(dir, ".gitignore"), ".tmb/\n.claude/\n.mcp.json\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  const command = env().tmbCommand;
  claudeCode.setup(dir, command);
  installPushGate(dir, command);
  withStore(dir, (store) => {
    tieProgram(store, HUMAN, { program: "tmb", version: VERSION, command: [...command] });
    writeSetting(store, HUMAN, "host", "claude-code");
    writeSetting(store, HUMAN, "host_roles", { "claude-code": "planner" });
    writeSetting(store, HUMAN, "base_branch", "main");
    writeSetting(store, HUMAN, "review_mode", "agile");
    writeSetting(store, HUMAN, "checks", ["bun test"]);
  });
  const graph = openGraphDb(dir);
  try {
    await buildLayer(graph, dir, baseCommit(dir, "main")!, BASE_LAYER);
  } finally {
    graph.close();
  }
}

function env(overrides: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    program: { name: "tmb", channel: "stable" },
    version: VERSION,
    installed: null,
    stateDir,
    tmbCommand: [path.join(binDir, "tmb")],
    adapters: HOST_ADAPTERS,
    cwd: project,
    path: binDir,
    platform: process.platform,
    isRunning: () => false,
    versionOf: () => null,
    gh: () => ({ installed: true, signedIn: true }),
    now: () => new Date("2026-11-20T10:00:00Z"),
    ...overrides,
  };
}

const notOk = (findings: Finding[]) => findings.filter((finding) => finding.status !== "ok");
const of = (findings: Finding[], check: string) => findings.filter((finding) => finding.check === check);

/** Answers each question with the next answer, and keeps the questions. */
function answering(...answers: string[]): { ask: (prompt: string) => Promise<string | null>; asked: string[] } {
  const asked: string[] = [];
  return { asked, ask: async (prompt) => (asked.push(prompt), answers.shift() ?? null) };
}

function io(ask: ((prompt: string) => Promise<string | null>) | null) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (text: string) => out.push(text), err: (text: string) => err.push(text), ask } };
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "tmb-doctor-"));
  process.env.XDG_CONFIG_HOME = path.join(root, ".no-xdg");
  process.env.GIT_CONFIG_GLOBAL = path.join(root, ".no-gitconfig");
  delete process.env.CLAUDE_PROJECT_DIR;
  stateDir = path.join(root, "state");
  mkdirSync(stateDir);
  binDir = path.join(root, "bin");
  mkdirSync(binDir);
  project = path.join(root, "project");
  await healthyProject(project);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("a healthy machine and project", () => {
  test("every check is fine and doctor exits 0", async () => {
    const findings = runChecks(env());
    expect(notOk(findings)).toEqual([]);
    expect(exitCode(findings)).toBe(0);
    const text = formatFindings(findings);
    expect(text).toContain("This machine");
    expect(text).toContain("This project");
    expect(text).toContain("Everything is fine.");
    const { out, io: doors } = io(null);
    expect(await runDoctorCommand([], env(), doors)).toBe(0);
    expect(out.join("\n")).toContain("✓ record: readable");
  });

  test("--json prints the same findings as data", async () => {
    const { out, io: doors } = io(null);
    expect(await runDoctorCommand(["--json"], env(), doors)).toBe(0);
    const data = JSON.parse(out.join("\n")) as { check: string; status: string }[];
    expect(data.map((finding) => finding.check)).toContain("old builds");
    expect(data.every((finding) => finding.status === "ok")).toBe(true);
  });

  test("doctor writes nothing to the record or the graph", () => {
    const before = [readFileSync(projectDbPath(project)), readFileSync(path.join(project, ".tmb", "graph.db"))];
    runChecks(env());
    expect(readFileSync(projectDbPath(project)).equals(before[0]!)).toBe(true);
    expect(readFileSync(path.join(project, ".tmb", "graph.db")).equals(before[1]!)).toBe(true);
  });
});

describe("the machine", () => {
  test("the installed program is not the one on the PATH", () => {
    const installed = path.join(root, "install", "tmb");
    mkdirSync(path.dirname(installed));
    writeFileSync(installed, "");
    writeFileSync(path.join(binDir, "tmb"), "#!/bin/sh\n");
    chmodSync(path.join(binDir, "tmb"), 0o755);
    const [program] = of(runChecks(env({ installed })), "program");
    expect(program!.status).toBe("warn");
    expect(program!.summary).toContain("another file");
    expect(program!.fix!.say).toContain("install.sh | TMB_CHANNEL=stable sh");
  });

  test("an unused old build is listed with its size and deleted only after a yes", async () => {
    const old = path.join(stateDir, "builds", "1.1.0");
    mkdirSync(old, { recursive: true });
    writeFileSync(path.join(old, "tmb"), "x".repeat(2048));
    const [build] = of(runChecks(env()), "old builds");
    expect(build!.status).toBe("warn");
    expect(build!.summary).toContain("tmb 1.1.0 (2.0 KB)");

    const no = answering("n");
    await runDoctorCommand(["--fix"], env(), io(no.ask).io);
    expect(no.asked.some((question) => question.includes("Delete the old build tmb 1.1.0"))).toBe(true);
    expect(existsSync(old)).toBe(true);

    const yes = answering("y");
    await runDoctorCommand(["--fix"], env(), io(yes.ask).io);
    expect(existsSync(old)).toBe(false);
  });

  test("an old build a running session uses is never offered", async () => {
    const old = path.join(stateDir, "builds", "1.1.0");
    mkdirSync(old, { recursive: true });
    writeFileSync(path.join(old, "tmb"), "x");
    mkdirSync(path.join(stateDir, "sessions"));
    writeFileSync(path.join(stateDir, "sessions", "4242.json"), JSON.stringify({ pid: 4242, project, startedAt: "2026-11-20T09:00:00Z", build: "1.1.0" }));
    const running = env({ isRunning: (pid) => pid === 4242 });
    const [build] = of(runChecks(running), "old builds");
    expect(build!.status).toBe("ok");
    expect(build!.summary).toContain("still uses it");
    expect(build!.fix).toBeUndefined();
    const asked = answering("y", "y", "y");
    await runDoctorCommand(["--fix"], running, io(asked.ask).io);
    expect(asked.asked.some((question) => question.includes("old build"))).toBe(false);
    expect(existsSync(old)).toBe(true);
  });

  test("a downloaded update that has not applied names why, and `tmb update`", () => {
    const installed = path.join(binDir, "tmb");
    writeFileSync(installed, "#!/bin/sh\n");
    chmodSync(installed, 0o755);
    const file = path.join(stateDir, "staged", "tmb");
    mkdirSync(path.dirname(file));
    writeFileSync(file, "");
    writeFileSync(path.join(stateDir, "staged.json"), JSON.stringify({ version: "1.3.0", channel: "stable", from: VERSION, file, sha256: "x" }));
    const [update] = of(runChecks(env({ installed })), "update");
    expect(update!.status).toBe("warn");
    expect(update!.summary).toContain("tmb 1.3.0 is downloaded and not applied yet");
    expect(update!.fix!.say).toBe("`tmb update`");
  });

  test("a failed look for an update is named", () => {
    const installed = path.join(binDir, "tmb");
    writeFileSync(installed, "#!/bin/sh\n");
    chmodSync(installed, 0o755);
    writeFileSync(path.join(stateDir, "last-check.json"), JSON.stringify({ at: "2026-11-20T08:00:00Z", outcome: "failed", error: "offline" }));
    const [update] = of(runChecks(env({ installed })), "update");
    expect(update!.summary).toContain("failed: offline");
  });

  test("entries of sessions whose process ended are removed after a yes", async () => {
    mkdirSync(path.join(stateDir, "sessions"));
    const entry = path.join(stateDir, "sessions", "999999.json");
    writeFileSync(entry, JSON.stringify({ pid: 999999, project, startedAt: "2026-11-19T09:00:00Z" }));
    const [sessions] = of(runChecks(env()), "session entries");
    expect(sessions!.status).toBe("warn");
    expect(sessions!.details).toEqual([`process 999999, in ${project}, started 2026-11-19T09:00:00Z`]);
    await runDoctorCommand(["--fix"], env(), io(answering("yes").ask).io);
    expect(existsSync(entry)).toBe(false);
  });

  test("files an update left half-way are found and removed after a yes", async () => {
    const installed = path.join(binDir, "tmb");
    writeFileSync(installed, "");
    writeFileSync(`${installed}.old`, "");
    writeFileSync(`${installed}.31337.new`, "");
    writeFileSync(path.join(stateDir, "update.lock"), "31337");
    writeFileSync(path.join(stateDir, "tmb-1.3.0.part"), "");
    const [left] = of(runChecks(env({ installed })), "update leftovers");
    expect(left!.status).toBe("warn");
    expect(left!.details).toHaveLength(4);
    await runDoctorCommand(["--fix"], env({ installed }), io(answering("y").ask).io);
    expect(existsSync(`${installed}.old`)).toBe(false);
    expect(existsSync(path.join(stateDir, "update.lock"))).toBe(false);
    expect(existsSync(installed)).toBe(true);
  });

  test("other channels' programs are shown, each with its version, and never fixed", () => {
    for (const name of ["tmb-rc", "tmb-1.0.0"]) {
      writeFileSync(path.join(binDir, name), "#!/bin/sh\n");
      chmodSync(path.join(binDir, name), 0o755);
    }
    const [others] = of(runChecks(env({ versionOf: (file) => `${path.basename(file)} 9.9.9 (x)` })), "other programs");
    expect(others!.status).toBe("ok");
    expect(others!.details).toEqual([`tmb-1.0.0 9.9.9 at ${path.join(binDir, "tmb-1.0.0")}`, `tmb-rc 9.9.9 at ${path.join(binDir, "tmb-rc")}`]);
  });

  test("a state folder a sandbox denies says so instead of asking for chmod", () => {
    const spy = spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    try {
      const [state] = of(runChecks(env()), "state folder");
      expect(state!.status).toBe("fail");
      expect(state!.summary).toContain("such as a sandbox");
      expect(state!.fix!.say).not.toContain("chmod");
    } finally {
      spy.mockRestore();
    }
  });

  test("a state folder its own permissions deny asks for chmod", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    mkdirSync(stateDir, { recursive: true });
    chmodSync(stateDir, 0o500);
    try {
      const [state] = of(runChecks(env()), "state folder");
      expect(state!.status).toBe("fail");
      expect(state!.fix!.say).toContain("chmod u+rwx");
    } finally {
      chmodSync(stateDir, 0o700);
    }
  });

  test("a state folder that is a file fails", () => {
    const file = path.join(root, "state-file");
    writeFileSync(file, "");
    const [state] = of(runChecks(env({ stateDir: file })), "state folder");
    expect(state!.status).toBe("fail");
    expect(exitCode(runChecks(env({ stateDir: file })))).toBe(1);
  });
});

describe("the project", () => {
  test("an unreadable record fails, and the machine checks still run", async () => {
    writeFileSync(projectDbPath(project), "this is not a database, it only looks like one ".repeat(200));
    const findings = runChecks(env());
    const [record] = of(findings, "record");
    expect(record!.status).toBe("fail");
    expect(of(findings, "state folder")[0]!.status).toBe("ok");
    expect(of(findings, "gh")[0]!.status).toBe("ok");
    expect(of(findings, "record checks")[0]!.summary).toContain("skipped");
    expect(exitCode(findings)).toBe(1);
  });

  test("a record a newer tmb reshaped names the program to use", () => {
    const db = new Database(projectDbPath(project));
    db.run("PRAGMA user_version = 999");
    db.close();
    const [record] = of(runChecks(env()), "record");
    expect(record!.status).toBe("fail");
    expect(record!.fix!.say).toContain("`tmb update`");
  });

  test("a host file that differs is found, with `tmb init --host`", () => {
    rmSync(roleFiles.filePath(project, "worker"));
    const [files] = notOk(of(runChecks(env()), "host files"));
    expect(files!.summary).toContain("Claude Code's files differ");
    expect(files!.details!.join("\n")).toContain("worker");
    expect(files!.fix!.say).toBe("`tmb init --host claude-code`");
  });

  test("git's push hook that is missing is found", () => {
    rmSync(path.join(project, ".git", "hooks", "pre-push"));
    const [gate] = notOk(of(runChecks(env()), "host files"));
    expect(gate!.summary).toContain("pre-push");
  });

  test("a project tied to another program is shown with what to run", () => {
    withStore(project, (store) => tieProgram(store, HUMAN, { program: "tmb-rc", version: "1.3.0-rc.1", command: ["tmb-rc"] }));
    const [tie] = of(runChecks(env()), "program tie");
    expect(tie!.status).toBe("warn");
    expect(tie!.summary).toContain("tied to tmb-rc 1.3.0-rc.1");
  });

  test("a running session pinning the project to an older build is shown", () => {
    mkdirSync(path.join(stateDir, "sessions"));
    writeFileSync(path.join(stateDir, "sessions", "77.json"), JSON.stringify({ pid: 77, project, startedAt: "x", build: "1.1.0" }));
    const findings = of(runChecks(env({ isRunning: (pid) => pid === 77 })), "program tie");
    expect(findings.some((finding) => finding.summary.includes("keeps this project on tmb 1.1.0"))).toBe(true);
  });

  test("the review mode not chosen names `tmb onboard`", () => {
    const other = path.join(root, "unchosen");
    mkdirSync(other);
    git(other, "init", "-q");
    withStore(other, (store) => {
      writeSetting(store, HUMAN, "base_branch", "main");
      writeSetting(store, HUMAN, "checks", ["bun test"]);
    });
    const [settings] = notOk(of(runChecks(env({ cwd: other })), "settings"));
    expect(settings!.summary).toContain("review mode is not chosen");
    expect(settings!.fix!.say).toBe("`tmb onboard`");
  });

  test("runs and tasks with a start and no end are shown for the planner to decide", () => {
    withStore(project, (store) => {
      const issue = store.createIssue(PLANNER, { title: "x" });
      store.appendTask(PLANNER, { issueId: issue, title: "never run", state: "open" });
      store.appendRun(PLANNER, { role: "worker" });
    });
    const [work] = of(runChecks(env()), "unfinished work");
    expect(work!.status).toBe("warn");
    expect(work!.details!.some((line) => line.includes('"never run" is open and no agent run is on it'))).toBe(true);
    expect(work!.details!.some((line) => line.includes("(worker)") && line.includes("has no end"))).toBe(true);
    expect(work!.fix!.apply).toBeUndefined();
  });

  test("an open docs task with no run is not listed: the planner writes it (trustmybot/tmb#460)", () => {
    withStore(project, (store) => {
      const issue = store.createIssue(PLANNER, { title: "x" });
      store.appendTask(PLANNER, { issueId: issue, title: "docs by the planner", state: "open", kind: "docs" });
      store.appendTask(PLANNER, { issueId: issue, title: "code nobody runs", state: "open", kind: "code" });
    });
    const [work] = of(runChecks(env()), "unfinished work");
    expect(work!.details!.some((line) => line.includes("docs by the planner"))).toBe(false);
    expect(work!.details!.some((line) => line.includes('"code nobody runs" is open and no agent run is on it'))).toBe(true);
  });

  test("only open docs tasks leave the unfinished work check ok", () => {
    withStore(project, (store) => {
      const issue = store.createIssue(PLANNER, { title: "x" });
      store.appendTask(PLANNER, { issueId: issue, title: "docs by the planner", state: "open", kind: "docs" });
    });
    const [work] = of(runChecks(env()), "unfinished work");
    expect(work!.status).toBe("ok");
  });

  test("a closed task's worktree and branch are removed after a yes", async () => {
    const worktree = path.join(root, "wt");
    git(project, "worktree", "add", "-q", "-b", "task/1", worktree);
    withStore(project, (store) => {
      const issue = store.createIssue(PLANNER, { title: "x" });
      store.appendTask(PLANNER, { issueId: issue, title: "done", state: "closed", branch: "task/1", worktree });
    });
    const [kept] = of(runChecks(env()), "closed tasks");
    expect(kept!.status).toBe("warn");
    expect(kept!.summary).toContain(`the worktree ${worktree} and the branch task/1 are still on disk`);
    await runDoctorCommand(["--fix"], env(), io(answering("y").ask).io);
    expect(existsSync(worktree)).toBe(false);
    expect(git(project, "branch", "--list", "task/1")).toBe("");
  });

  test("another tool's pre-push hook gets tmb's line first after a yes, and an older line at its end is moved there (trustmybot/tmb#218)", async () => {
    const hook = path.join(project, ".git", "hooks", "pre-push");
    const other = '#!/bin/sh\ncat > /dev/null\n';
    // An older added line, at the end, after the other tool has read git's ref lines.
    const older = "if command -v 'tmb' >/dev/null 2>&1; then 'tmb' 'pre-push' '--project' '.' \"$@\" || exit 1; fi # tmb: added for the push gate; tmb remove takes this line out.";
    for (const before of [other, `${other}${older}\n`]) {
      writeFileSync(hook, before, { mode: 0o755 });
      const off = () => of(runChecks(env()), "host files").filter((finding) => finding.summary.includes("the push gate is off where git's pre-push hook is another tool's"));
      expect(off().map((finding) => finding.status)).toEqual(["warn"]);
      await runDoctorCommand(["--fix"], env(), io(answering("y").ask).io);
      const [shebang, line, ...rest] = readFileSync(hook, "utf8").split("\n");
      expect(shebang).toBe("#!/bin/sh");
      expect(line).toContain("'tmb' 'pre-push' '--project' '.'");
      expect(line).toContain('exec < "$tmb_refs"');
      expect([shebang, ...rest].join("\n")).toBe(other);
      expect(off()).toEqual([]);
    }
  });

  test("a code graph behind its base branch names `tmb index`", () => {
    writeFileSync(path.join(project, "b.ts"), "export const b = 2;\n");
    git(project, "add", "b.ts");
    git(project, "commit", "-q", "-m", "second");
    const [graph] = of(runChecks(env()), "code graph");
    expect(graph!.status).toBe("warn");
    expect(graph!.summary).toContain("behind main");
    expect(graph!.fix!.say).toBe("`tmb index`");
  });

  test("gh not signed in names the sign-in step", () => {
    const [gh] = of(runChecks(env({ gh: () => ({ installed: true, signedIn: false }) })), "gh");
    expect(gh!.status).toBe("warn");
    expect(gh!.fix!.say).toBe("`gh auth login`");
  });

  test("another record above or below the project is shown", () => {
    mkdirSync(path.join(project, "sub", "deeper", ".tmb"), { recursive: true });
    writeFileSync(path.join(project, "sub", "deeper", ".tmb", "trajectory.db"), "");
    const [others] = of(runChecks(env()), "other records");
    expect(others!.status).toBe("warn");
    expect(others!.details).toEqual([`below: ${path.join(project, "sub", "deeper")}`]);
  });

  test("a folder with no record skips the project's checks", () => {
    const empty = path.join(root, "empty");
    mkdirSync(empty);
    const findings = runChecks(env({ cwd: empty }));
    expect(findings.filter((finding) => finding.scope === "project")).toHaveLength(1);
    expect(exitCode(findings)).toBe(0);
  });
});

describe("--fix", () => {
  test("with no terminal it changes nothing and says so", async () => {
    const old = path.join(stateDir, "builds", "1.1.0");
    mkdirSync(old, { recursive: true });
    const { err, io: doors } = io(null);
    await runDoctorCommand(["--fix"], env(), doors);
    expect(existsSync(old)).toBe(true);
    expect(err.join("\n")).toContain("nothing was changed");
  });

  test("a check that throws looks like tmb's bug and names `tmb feedback`", async () => {
    const throwing = env({ gh: () => { throw new Error("boom"); } });
    const bugs: Finding[] = [];
    const { io: doors } = io(null);
    expect(await runDoctorCommand([], throwing, { ...doors, keepBug: (finding) => bugs.push(finding) })).toBe(1);
    expect(bugs).toHaveLength(1);
    expect(bugs[0]!.fix!.say).toContain("tmb feedback");
    expect(findingsJson(bugs)).toContain('"bug": true');
  });
});

describe("the planner's session start", () => {
  test("says only how many things need a look, in one line", () => {
    withStore(project, (store) => store.appendRun(PLANNER, { role: "worker" }));
    mkdirSync(path.join(stateDir, "sessions"));
    writeFileSync(path.join(stateDir, "sessions", "999999.json"), JSON.stringify({ pid: 999999, project }));
    const line = sessionStartLine(env());
    // The ended session's entry and the run with no end: two findings, counted, not listed.
    expect(line).toBe("2 things need a look: `tmb doctor`");
    const answer = handleEvent({ type: "session-start", projectDir: project, unattended: false, doctor: () => line });
    expect(answer.context).toContain(DOCTOR_HEADING);
    expect(answer.context).toContain("2 things need a look");
  });

  test("says nothing when doctor finds nothing", () => {
    expect(sessionStartLine(env())).toBeNull();
    const answer = handleEvent({ type: "session-start", projectDir: project, unattended: false, doctor: () => null });
    expect(answer.context).not.toContain(DOCTOR_HEADING);
  });
});

// trustmybot/tmb#258: a project set up before workspaces, in a folder that is no repo and holds
// repos, which the record does not name. Its record treats the folder as the one repo.
describe("a folder of repos the record does not name", () => {
  let folder: string;
  beforeEach(() => {
    folder = path.join(root, "folder");
    for (const name of ["plugin", "tmb"]) {
      const dir = path.join(folder, name);
      mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q", "-b", "dev");
      git(dir, "config", "user.email", "t@example.com");
      git(dir, "config", "user.name", "T");
      writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "first");
    }
    const command = env().tmbCommand;
    claudeCode.setup(folder, command);
    withStore(folder, (store) => {
      tieProgram(store, HUMAN, { program: "tmb", version: VERSION, command: [...command] });
      writeSetting(store, HUMAN, "host", "claude-code");
      writeSetting(store, HUMAN, "host_roles", { "claude-code": "planner" });
      writeSetting(store, HUMAN, "base_branch", "dev");
      writeSetting(store, HUMAN, "review_mode", "agile");
      writeSetting(store, HUMAN, "checks", ["bun test"]);
    });
  });

  test("doctor says the push gate is off and the repos are not set, naming them and init run again", () => {
    const findings = runChecks(env({ cwd: folder }));
    const gate = of(findings, "host files").find((finding) => finding.summary.includes("push gate"))!;
    expect(gate.status).toBe("warn");
    expect(gate.summary).toBe("the push gate is off: this folder is not a git repo, and the record names none of the 2 repos in it");
    expect(gate.details).toEqual(["plugin", "tmb"]);
    expect(gate.fix!.say).toContain("`tmb init`, run again in the project folder, names them and writes the push hook in each");
    expect(gate.fix!.say).toContain("meets the push gate at its next push");
    const settings = of(findings, "settings");
    expect(settings.map((finding) => finding.status)).toEqual(["warn"]);
    expect(settings[0]!.summary).toContain("the repos are not set");
    expect(settings[0]!.details).toEqual(["plugin", "tmb"]);
    expect(findings.some((finding) => finding.summary.includes("every setting is set"))).toBe(false);
  });

  test("the code graph's fix is init run again, and tmb index says the same", async () => {
    const [graph] = of(runChecks(env({ cwd: folder })), "code graph");
    expect(graph!.status).toBe("warn");
    expect(graph!.summary).toContain("no code graph can be built here");
    expect(graph!.fix!.say).toContain("`tmb init`, run again");
    const error = await withStore(folder, (store) => indexProject(folder, store, { rebuild: false })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HandlerError);
    expect((error as HandlerError).message).toContain("holds the repos plugin, tmb, which the record does not name. Run `tmb init` there again");
  });

  test("the planner's session start says the gate is off in its one line", () => {
    expect(sessionStartLine(env({ cwd: folder }))).toStartWith("the push gate is off: the record names none of the 2 repos in this folder; ");
  });

  test("a project that is a repo itself is not such a folder", () => {
    const findings = runChecks(env());
    expect(notOk(findings)).toEqual([]);
    expect(of(findings, "host files").some((finding) => finding.summary === "git's pre-push hook runs the push gate")).toBe(true);
  });
});

describe("the hosts' wiring gaps", () => {
  for (const adapter of [claudeCode, codex]) {
    test(`${adapter.name}: none after setup, one after a role file is removed`, () => {
      const dir = path.join(root, `wired-${adapter.id}`);
      mkdirSync(dir);
      git(dir, "init", "-q");
      const command = ["/opt/tmb/bin/tmb"];
      adapter.setup(dir, command);
      expect(adapter.wiringGaps!(dir, command)).toEqual([]);
      expect(adapter.wiringGaps!(dir, ["/elsewhere/tmb"]).length).toBeGreaterThan(0);
    });
  }
});
