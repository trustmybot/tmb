// Integration: git's pre-push hook, which setup writes, asks tmb about every push from the
// project, one an agent runs or one the Human types. A push to the base branch is refused while
// it brings a commit no reviewed or waived feature branch tip holds, and the base branch is
// never deleted; a feature branch's backup push goes through. Each push here is a real git push
// to a bare origin, typed as the Human would.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openProjectStore } from "../../src/engine/index.ts";
import { BASE_BRANCH, callJson, tmbProcesses } from "./tmb-processes.ts";

const { env, git, tmb, tmbJson, setUpProject, commitFile, startSubagent, hook, connect, cleanup } = tmbProcesses("tmb-push-gate-");
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
  test("setup writes git's pre-push hook, remove deletes it, and a hook that is not tmb's is left alone", () => {
    const project = setUpProject("true");
    const file = hookFile(project);
    expect(readFileSync(file, "utf8")).toContain("# tmb: the push gate.");
    expect(statSync(file).mode & 0o111).not.toBe(0);
    expect(tmb(["remove"], project)).toContain("Removed git's pre-push hook");
    expect(existsSync(file)).toBe(false);

    writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(tmb(["setup", "--base", BASE_BRANCH, "--yes"], project)).toContain("is not tmb's, so it was left alone");
    expect(readFileSync(file, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    tmb(["remove"], project);
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

  test("the host guards: no agent skips the hook, and a worker or the reviewer never pushes", () => {
    const project = setUpProject("true");
    const bash = (command: string, agentType?: string) => {
      const out = hook(project, "pre-tool-use", {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        ...(agentType === undefined ? {} : { agent_type: agentType }),
      });
      return out === "" ? "allow" : (JSON.parse(out).hookSpecificOutput.permissionDecisionReason as string);
    };
    expect(bash("git push --no-verify origin main")).toContain("pre-push hook");
    expect(bash("git -c core.hooksPath=/dev/null push origin main")).toContain("core.hooksPath");
    expect(bash("git push origin feat/x", "worker")).toContain("A worker never pushes");
    expect(bash("git push origin feat/x", "reviewer")).toContain("A reviewer never pushes");
    expect(bash("gh pr create --fill")).toContain("feature_pr");
    expect(bash("git push origin feat/x")).toBe("allow");
  });
});
