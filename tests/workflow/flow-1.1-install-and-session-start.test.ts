// Flow 1.1, Install and session start (docs/flows/FLOWS.md): this file is its scenario test.
// `tmb init` on a fresh project, run as the Human runs it, then the host's session start. The
// one-step install itself is the Install layer's (tests/install).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../lib/paths.ts";
import { installPinnedTools } from "../lib/pinned-tools.ts";
import { CLI, tmbProcesses } from "../lib/tmb-processes.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

// A machine with tmb's pinned tools installed: init then names no missing tool.
beforeAll(installPinnedTools);

const NO_INPUT_LIMIT_MS = 20_000;
const EMPTY = { base_branch: null, review_mode: null, checks: null, shared_folders: null, graph_links: null };
const PLANNER_ROLE = readFileSync(path.join(REPO_ROOT, "roles", "planner.md"), "utf8");
const { env, newProject, config, sessionStart, cleanup } = tmbProcesses("tmb-flow-install-");
afterAll(cleanup);

describe("flow 1.1: install and session start", () => {
  test("init prepares a fresh project with no question asked, and ends saying how the settings get filled and that the review mode is the Human's; the session start then briefs the planner", async () => {
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

    // The Human opens the host: its session start gives the planner its role and the project's state.
    const context = sessionStart(project);
    expect(context.split("\n")[0]).toBe(PLANNER_ROLE.split("\n")[0]);
    expect(context).toContain("## The project's settings are empty");
  });

});
