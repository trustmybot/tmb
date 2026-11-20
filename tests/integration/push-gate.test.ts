// Integration: git's pre-push hook, which init writes, asks tmb about every push from the
// project, one an agent runs or one the Human types. A push to the base branch is refused while
// it brings a commit no reviewed or waived feature branch tip holds, and the base branch is
// never deleted; a feature branch's backup push goes through. Each push here is a real git push
// to a bare origin, typed as the Human would.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openProjectStore } from "../../src/engine/index.ts";
import { BASE_BRANCH, callJson, tmbProcesses } from "./tmb-processes.ts";


const { scratch, env, git, run, tmb, human, tmbJson, setUpProject, commitFile, startSubagent, hook, connect, cleanup } = tmbProcesses("tmb-push-gate-");
afterAll(cleanup);

/** A push typed by hand: git runs the pre-push hook; returns its exit status and what it said. */
function push(project: string, ...args: string[]) {
  const result = spawnSync("git", ["push", ...args], { cwd: project, env, encoding: "utf8", timeout: 60_000 });
  return { status: result.status, stderr: result.stderr };
}

function hookFile(project: string): string {
  return path.join(project, ".git", "hooks", "pre-push");
}

function pushDecisions(project: string) {
  const opened = openProjectStore(project, { create: false });
  if (!opened.ok) throw opened.error;
  try {
    return opened.store.listGuardDecisions().filter((decision) => JSON.parse(decision.event).type === "before-push");
  } finally {
    opened.store.close();
  }
}

describe("the push gate", () => {
  test("init writes git's pre-push hook, remove deletes it, and a hook that is not tmb's is left alone", () => {
    const project = setUpProject("true");
    const file = hookFile(project);
    expect(readFileSync(file, "utf8")).toContain("# tmb: the push gate.");
    expect(statSync(file).mode & 0o111).not.toBe(0);
    expect(human(["remove"], project)).toContain("Removed git's pre-push hook");
    expect(existsSync(file)).toBe(false);

    writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(tmb(["init"], project)).toContain("is not tmb's, so it was left alone");
    expect(readFileSync(file, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    human(["remove"], project);
    expect(readFileSync(file, "utf8")).toBe("#!/bin/sh\nexit 0\n");
  });

  test("refuses a push typed by hand that brings unreviewed commits onto the base branch, and any delete of it", () => {
    const project = setUpProject("true", undefined, { origin: true });
    const remoteBase = git(project, "rev-parse", `origin/${BASE_BRANCH}`);
    const unreviewed = commitFile(project, "hotfix.txt", "fix\n", "a hotfix straight on main");

    const refused = push(project, "origin", BASE_BRANCH);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("tmb refused the push to origin");
    expect(refused.stderr).toContain(unreviewed.slice(0, 7));
    expect(refused.stderr).toContain("a hotfix straight on main");
    expect(git(project, "ls-remote", "origin", `refs/heads/${BASE_BRANCH}`)).toStartWith(remoteBase);

    const deleted = push(project, "origin", `:${BASE_BRANCH}`);
    expect(deleted.status).not.toBe(0);
    expect(deleted.stderr).toContain("tmb never lets the base branch go");

    // Any other branch goes through, and every push's decision is in the record.
    git(project, "checkout", "-q", "-b", "scratch");
    expect(push(project, "-q", "origin", "scratch").status).toBe(0);
    expect(pushDecisions(project).map((decision) => decision.decision)).toEqual(["deny", "deny", "allow"]);
    expect(pushDecisions(project)[0]!.createdBy).toEqual({ kind: "human" });
  });

  test("trusts only what the remote holds: not a feature's starting point, nor a remote-tracking ref set by hand", async () => {
    const project = setUpProject("true", undefined, { origin: true });
    const unpushed = commitFile(project, "hotfix.txt", "fix\n", "an unpushed commit on main");
    // A feature cut now starts at the unpushed commit; that must not count it as on the remote.
    const client = await connect(project, "claude-code");
    try {
      await callJson(client, "feature_start", { name: "feat/later" });
    } finally {
      await client.close();
    }
    expect(push(project, "origin", BASE_BRANCH).stderr).toContain(unpushed.slice(0, 7));

    git(project, "update-ref", `refs/remotes/origin/${BASE_BRANCH}`, "HEAD");
    const forged = push(project, "origin", BASE_BRANCH);
    expect(forged.status).not.toBe(0);
    expect(forged.stderr).toContain("an unpushed commit on main");
  });

  test("lets the base branch take a feature branch once the reviewer passed its tip, and not before", async () => {
    const project = setUpProject("true", undefined, { origin: true });
    const issue = tmbJson(["issue", "create", "Greet the user"], project);
    const client = await connect(project, "claude-code");
    try {
      await callJson(client, "feature_start", { name: "feat/greet" });
      const task = await callJson(client, "task_start", {
        issue_id: issue.id,
        kind: "code",
        intent: "Add the greeting",
        files: ["src"],
        criteria: ["SC1: greet() exists"],
      });
      const tip = commitFile(task.worktree, "src/greet.ts", "export const greet = () => 'hi';\n", "add greet");
      // The close pushes the feature branch to origin as a backup, through the same hook.
      expect((await callJson(client, "task_close", { id: task.id, role: "worker" })).push).toMatchObject({ result: "pushed" });
      expect(git(project, "ls-remote", "origin", "refs/heads/feat/greet")).toStartWith(tip);

      git(project, "merge", "-q", "--ff-only", "feat/greet");
      expect(push(project, "origin", BASE_BRANCH).stderr).toContain("add greet");
      // The close's push is recorded as the worker's that closed the task; the push typed by hand stays the Human's (#134).
      expect(pushDecisions(project).map((decision) => [decision.decision, decision.createdBy])).toEqual([
        ["allow", { kind: "agent", role: "worker", host: "claude-code" }],
        ["deny", { kind: "human" }],
      ]);

      expect(startSubagent(project, "reviewer", "feature=feat/greet")).toBeNull();
      await callJson(client, "review_record", { feature: "feat/greet", commit: tip, verdict: "pass", role: "reviewer" });
      const allowed = push(project, "origin", BASE_BRANCH);
      expect(allowed.stderr).not.toContain("tmb refused");
      expect(allowed.status).toBe(0);
      expect(git(project, "ls-remote", "origin", `refs/heads/${BASE_BRANCH}`)).toStartWith(tip);
    } finally {
      await client.close();
    }
  });

  test("tmb reads no shell command: a push typed with --no-verify is not refused by tmb and reaches the remote", () => {
    const project = setUpProject("true", undefined, { origin: true });
    const bash = (command: string, agentType?: string) => {
      const out = hook(project, "pre-tool-use", {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        ...(agentType === undefined ? {} : { agent_type: agentType }),
      });
      return out === "" ? "allow" : (JSON.parse(out).hookSpecificOutput.permissionDecisionReason as string);
    };
    for (const agentType of [undefined, "worker", "reviewer"]) {
      expect(bash("git push --no-verify origin main", agentType)).toBe("allow");
      expect(bash("git -c core.hooksPath=/dev/null push origin main", agentType)).toBe("allow");
      expect(bash("gh pr create --fill", agentType)).toBe("allow");
    }

    // The flag skips git's pre-push hook, so the unreviewed commit reaches the base branch on the remote.
    // Nothing stops it at that moment: a later sync is what finds it (trustmybot/tmb#98 Part E).
    const unreviewed = commitFile(project, "hotfix.txt", "fix\n", "a hotfix with the hook skipped");
    expect(push(project, "-q", "--no-verify", "origin", BASE_BRANCH).status).toBe(0);
    expect(git(project, "ls-remote", "origin", `refs/heads/${BASE_BRANCH}`)).toStartWith(unreviewed);
    expect(pushDecisions(project)).toHaveLength(0);
  });
});

/**
 * A repo on a bare origin whose tmb project is the subfolder pkg, one package of a monorepo
 * (trustmybot/tmb#178). The check passes only in pkg, where pkg-marker is.
 */
function setUpSubfolderProject(): { repo: string; project: string } {
  const repo = mkdtempSync(path.join(scratch, "monorepo-"));
  const project = path.join(repo, "pkg");
  git(repo, "init", "-q", "-b", BASE_BRANCH);
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@example.com");
  mkdirSync(project);
  writeFileSync(path.join(repo, "README.md"), "the monorepo\n");
  writeFileSync(path.join(project, "pkg-marker"), "pkg\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  const origin = `${repo}-origin.git`;
  git(scratch, "init", "-q", "--bare", origin);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", BASE_BRANCH);
  tmb(["init"], project);
  human(["onboard", "--base", BASE_BRANCH, "--review-mode", "agile", "--check", "test -f pkg-marker", "--yes"], project);
  return { repo, project };
}

describe("the push gate of a project below its repo's top", () => {
  test("the hook names the project, so an unreviewed push from the repo's top is refused", () => {
    const { repo, project } = setUpSubfolderProject();
    expect(readFileSync(hookFile(repo), "utf8")).toContain("'--project' 'pkg'");
    const unreviewed = commitFile(repo, "pkg/hotfix.txt", "fix\n", "a hotfix straight on main");
    const refused = push(repo, "origin", BASE_BRANCH);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("tmb refused the push to origin");
    expect(refused.stderr).toContain(unreviewed.slice(0, 7));
    expect(pushDecisions(project).map((decision) => decision.decision)).toEqual(["deny"]);
  });

  test("a task's checks run in the project folder, and its spec's paths are the project's", async () => {
    const { project } = setUpSubfolderProject();
    const issue = tmbJson(["issue", "create", "Greet the user"], project);
    const client = await connect(project, "claude-code");
    try {
      await callJson(client, "feature_start", { name: "feat/greet" });
      const task = await callJson(client, "task_start", { issue_id: issue.id, kind: "code", intent: "Add the greeting", files: ["src"], criteria: ["SC1: greet() exists"] });
      commitFile(task.worktree, "pkg/src/greet.ts", "export const greet = () => 'hi';\n", "add greet");
      commitFile(task.worktree, "README.md", "the monorepo, greeted\n", "touch the repo's top");
      const closed = await callJson(client, "task_close", { id: task.id, role: "worker" });
      expect(closed.outsideSpec).toEqual(["../README.md"]);
    } finally {
      await client.close();
    }
  });

  test("a hook with no record behind it says so, and a second project in the repo is refused at init", () => {
    const { repo, project } = setUpSubfolderProject();
    const second = path.join(repo, "other");
    mkdirSync(second);
    const refused = run(["init"], second);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(`this repo already holds the tmb project in ${project}`);

    rmSync(path.join(project, ".tmb"), { recursive: true, force: true });
    commitFile(repo, "pkg/hotfix.txt", "fix\n", "a hotfix");
    const allowed = push(repo, "-q", "origin", BASE_BRANCH);
    expect(allowed.status).toBe(0);
    expect(allowed.stderr).toContain(`tmb found no project record in ${project}, so the push gate judged nothing`);
  });
});
