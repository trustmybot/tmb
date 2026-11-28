// Workflow simulation: what a close checks beyond the checks (trustmybot/tmb#98), and a worker
// that starts in a worktree its host made. A commit outside the task's declared files closes and
// the close names the files and leaves the spec as written; a change left in the main folder during the task is reported at
// close, with how to put it back; the host's worktree is adopted as the task's and cleaned up at close.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLI, callJson, tmbProcesses } from "../lib/tmb-processes.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const { env, git, tmbJson, setUpProject, commitFile, connect, cleanup } = tmbProcesses("tmb-close-checks-");
afterAll(cleanup);

const CHECK = "true";

async function startTask(project: string, files: string[]) {
  const issue = tmbJson(["issue", "create", "A goal"], project);
  const client = await connect(project);
  await callJson(client, "feature_start", { name: "feat/goal" });
  const started = await callJson(client, "task_start", { issue_id: issue.id, kind: "code", intent: "Do the goal", files, criteria: ["SC1: done"] });
  return { client, started, worker: { id: started.id, role: "worker" } };
}

/** Runs a shell command in the main folder, as the Human would to put a file back. */
function sh(cwd: string, command: string): void {
  const result = spawnSync(command, { shell: true, cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`);
}

describe("a close's checks beyond the checks", () => {
  test("a commit outside the task's files closes, and the close names them and leaves the spec as written", async () => {
    const project = setUpProject(CHECK);
    const { client, started, worker } = await startTask(project, ["src/a.txt"]);
    try {
      commitFile(started.worktree, "src/a.txt", "a\n", "a");
      commitFile(started.worktree, "docs/extra.md", "one more\n", "extra");
      const closed = await callJson(client, "task_close", worker);
      expect(closed.brief.state).toBe("closed");
      expect(closed.outsideSpec).toEqual(["docs/extra.md"]);
      expect(closed.notes.join("\n")).toContain("outside the task's declared files, for the planner or the reviewer to check: docs/extra.md");
      expect(closed.brief.spec.files).toEqual(["src/a.txt"]);
      expect((await callJson(client, "task_brief", worker)).spec.files).toEqual(["src/a.txt"]);
    } finally {
      await client.close();
    }
  });

  test("a change made in the main folder during the task is reported at close with how to put it back; one there before is not", async () => {
    const project = setUpProject(CHECK, { "README.md": "hello\n", "keep.txt": "keep\n" });
    // Left uncommitted before the task starts: the task did not make it, so the close does not name it.
    writeFileSync(path.join(project, "before.txt"), "the Human's own\n");
    const { client, started, worker } = await startTask(project, ["src/a.txt"]);
    try {
      commitFile(started.worktree, "src/a.txt", "a\n", "a");
      // A shell command's stray writes: one new file, one changed and one deleted.
      writeFileSync(path.join(project, "stray.txt"), "copied by a shell command\n");
      writeFileSync(path.join(project, "README.md"), "overwritten\n");
      sh(project, "rm keep.txt");

      const closed = await callJson(client, "task_close", worker);
      expect(closed.brief.state).toBe("closed");
      const changes = closed.mainFolder.changes as { path: string; change: string; putBack: string }[];
      expect(changes.map((change) => [change.path, change.change])).toEqual([
        ["README.md", "changed"],
        ["keep.txt", "deleted"],
        ["stray.txt", "added"],
      ]);
      expect(closed.notes.join("\n")).toContain("The main folder changed while the task was open");

      for (const change of changes) sh(project, change.putBack);
      expect(readFileSync(path.join(project, "README.md"), "utf8")).toBe("hello\n");
      expect(readFileSync(path.join(project, "keep.txt"), "utf8")).toBe("keep\n");
      expect(existsSync(path.join(project, "stray.txt"))).toBe(false);
      expect(readFileSync(path.join(project, "before.txt"), "utf8")).toBe("the Human's own\n");
      // The copy kept for the compare is let go once the task closes.
      expect(git(project, "for-each-ref", "refs/tmb/")).toBe("");
    } finally {
      await client.close();
    }
  });

  test("a close with nothing changed in the main folder and no file outside the task says nothing more", async () => {
    const project = setUpProject(CHECK);
    const { client, started, worker } = await startTask(project, ["src"]);
    try {
      commitFile(started.worktree, "src/a.txt", "a\n", "a");
      const closed = await callJson(client, "task_close", worker);
      expect(closed).toMatchObject({ outsideSpec: [], notes: [], mainFolder: { changes: [] } });
    } finally {
      await client.close();
    }
  });
});

describe("a worker in a worktree its host made", () => {
  test("tmb adopts the host's worktree as the task's when the worker names its task from there, and the close cleans it up", async () => {
    const project = setUpProject(CHECK);
    const { client, started, worker } = await startTask(project, ["src/a.txt"]);
    try {
      // What Claude Code does for a subagent with worktree isolation: a worktree in the project on a branch of its own.
      const hostWorktree = path.join(project, ".claude", "worktrees", "agent-a1b2c3");
      git(project, "worktree", "add", "-q", "-b", "worktree-agent-a1b2c3", hostWorktree, "main");

      // The worker's first call to tmb, from its own folder; Claude Code keeps its project dir at the main folder.
      const input = JSON.stringify({
        session_id: "workflow",
        hook_event_name: "PreToolUse",
        cwd: hostWorktree,
        agent_id: "a1b2c3",
        agent_type: "worker",
        tool_name: "mcp__tmb__task_brief",
        tool_input: { id: started.id, role: "worker" },
      });
      const hooked = spawnSync(process.execPath, [CLI, "hook", "pre-tool-use"], { cwd: hostWorktree, env: { ...env, CLAUDE_PROJECT_DIR: project }, input, encoding: "utf8" });
      expect({ status: hooked.status, stdout: hooked.stdout, stderr: hooked.stderr }).toEqual({ status: 0, stdout: "", stderr: "" });

      const brief = await callJson(client, "task_brief", worker);
      expect(realpathSync(brief.worktree)).toBe(realpathSync(hostWorktree));
      expect(git(hostWorktree, "branch", "--show-current")).toBe(started.branch);
      expect(existsSync(started.worktree)).toBe(false);
      expect(git(project, "branch", "--list", "worktree-agent-a1b2c3")).toBe("");

      // A second call from the same folder changes nothing.
      spawnSync(process.execPath, [CLI, "hook", "pre-tool-use"], { cwd: hostWorktree, env: { ...env, CLAUDE_PROJECT_DIR: project }, input, encoding: "utf8" });
      expect(realpathSync((await callJson(client, "task_brief", worker)).worktree)).toBe(realpathSync(hostWorktree));

      commitFile(hostWorktree, "src/a.txt", "a\n", "a");
      const closed = await callJson(client, "task_close", worker);
      expect(closed).toMatchObject({ brief: { state: "closed" }, cleanupProblems: [], outsideSpec: [], mainFolder: { changes: [] } });
      expect(existsSync(hostWorktree)).toBe(false);
      expect(git(project, "branch", "--list", started.branch)).toBe("");
    } finally {
      await client.close();
    }
  });

  test("a worker that committed in its host's folder before naming its task is refused at close, and told where its commits are", async () => {
    const project = setUpProject(CHECK);
    const { client, started, worker } = await startTask(project, ["src/a.txt"]);
    try {
      const hostWorktree = path.join(project, ".claude", "worktrees", "agent-d4e5f6");
      git(project, "worktree", "add", "-q", "-b", "worktree-agent-d4e5f6", hostWorktree, started.brief.baseCommit);
      commitFile(hostWorktree, "src/a.txt", "a\n", "a");
      const input = JSON.stringify({
        session_id: "workflow",
        hook_event_name: "PreToolUse",
        cwd: hostWorktree,
        agent_type: "worker",
        tool_name: "mcp__tmb__task_close",
        tool_input: { id: started.id, role: "worker" },
      });
      spawnSync(process.execPath, [CLI, "hook", "pre-tool-use"], { cwd: hostWorktree, env: { ...env, CLAUDE_PROJECT_DIR: project }, input, encoding: "utf8" });
      // The host's folder holds a commit of its own, so it is not adopted, and the task's worktree holds none of the work.
      expect((await callJson(client, "task_brief", worker)).worktree).toBe(started.worktree);
      const refused = await client.callTool({ name: "task_close", arguments: worker });
      expect(refused.isError).toBe(true);
      const text = JSON.stringify(refused.content);
      expect(text).toContain("no commit past the base commit");
      expect(text).toContain(realpathSync(hostWorktree));
      expect((await callJson(client, "task_brief", worker)).state).toBe("open");
    } finally {
      await client.close();
    }
  });

  test("a worker that names its task from the main folder or from its task's own worktree keeps the task's worktree as it is", async () => {
    const project = setUpProject(CHECK);
    const { client, started, worker } = await startTask(project, ["src/a.txt"]);
    try {
      for (const folder of [project, started.worktree]) {
        const input = JSON.stringify({
          session_id: "workflow",
          hook_event_name: "PreToolUse",
          cwd: folder,
          agent_type: "worker",
          tool_name: "mcp__tmb__task_close",
          tool_input: { id: started.id, role: "worker" },
        });
        const hooked = spawnSync(process.execPath, [CLI, "hook", "pre-tool-use"], { cwd: folder, env: { ...env, CLAUDE_PROJECT_DIR: project }, input, encoding: "utf8" });
        expect({ status: hooked.status, stdout: hooked.stdout }).toEqual({ status: 0, stdout: "" });
        expect((await callJson(client, "task_brief", worker)).worktree).toBe(started.worktree);
        expect(existsSync(started.worktree)).toBe(true);
      }
    } finally {
      await client.close();
    }
  });
});
