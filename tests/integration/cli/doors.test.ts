// Both ways into the record, driven as separate processes the way a host and the Human use
// them: init, onboard and remove, the tool server over stdio, the record commands, and session start.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathWithFakeClaude } from "../../lib/fake-host.ts";
import { asHuman } from "../../lib/as-human.ts";
import { REPO_ROOT } from "../../lib/paths.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const ROOT = REPO_ROOT;
const CLI = path.join(ROOT, "src", "cli", "index.ts");
const TOOLS = [
  "issue_create",
  "issue_list",
  "issue_get",
  "issue_update",
  "discussion_append",
  "search",
  "history",
  "settings_get",
  "settings_set",
  "role_list",
  "role_change",
  "role_create",
  "role_delete",
  "feature_start",
  "feature_update",
  "feature_drop",
  "feature_list",
  "feature_brief",
  "review_record",
  "feature_waive",
  "feature_pr",
  "task_start",
  "task_brief",
  "task_close",
  "task_drop",
  "task_list",
  "task_review",
  "task_waive",
  "task_pr",
  "graph_map",
  "graph_find",
  "graph_symbol",
  "graph_scope",
  "graph_concept_upsert",
  "graph_concepts",
  "graph_area_upsert",
  "graph_area_remove",
  "graph_areas",
  "graph_miss",
  "feedback_draft",
  "feedback_send",
];

let scratch: string;
let env: Record<string, string>;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-doors-")));
  // Keep the machine's global git ignore rules out of the project under test.
  env = {
    ...(process.env as Record<string, string>),
    XDG_CONFIG_HOME: path.join(scratch, "no-xdg"),
    GIT_CONFIG_GLOBAL: path.join(scratch, "no-gitconfig"),
    PATH: pathWithFakeClaude(scratch),
  };
  delete env.CLAUDE_PROJECT_DIR;
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(args: string[], cwd: string, input?: string) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, input, env, encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs a tmb command that must succeed and returns its stdout. */
/** Runs a step only the Human may take, on a terminal where the Human types yes; returns what the terminal showed. */
function human(args: string[], cwd: string): string {
  const result = asHuman(process.execPath, [CLI, ...args], { cwd, env });
  if (result.status !== 0) throw new Error(`tmb ${args.join(" ")} exited ${result.status}: ${result.output}`);
  return result.output;
}

function tmb(args: string[], cwd: string): string {
  const result = run(args, cwd);
  if (result.status !== 0) throw new Error(`tmb ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function tmbJson<T = any>(args: string[], cwd: string): T {
  return JSON.parse(tmb([...args, "--json"], cwd)) as T;
}

function newGitProject(): string {
  const project = mkdtempSync(path.join(scratch, "project-"));
  const init = spawnSync("git", ["init", "-q"], { cwd: project, env, timeout: 10_000 });
  expect(init.status).toBe(0);
  return project;
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** A connected MCP client on `tmb mcp --host test --project <dir>`: connecting sends initialize. */
async function connect(project: string): Promise<Client> {
  const client = new Client({ name: "doors-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp", "--host", "test", "--project", project],
    env,
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function callJson<T = any>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await call(client, name, args);
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0]!.text) as T;
}

describe("init and remove", () => {
  test("init creates the record, registers and enables the tool server, and is idempotent; remove undoes it and keeps the rest", () => {
    const project = newGitProject();
    const mcpFile = path.join(project, ".mcp.json");
    const settingsFile = path.join(project, ".claude", "settings.local.json");
    const otherServer = { command: "other-server", args: ["--stdio"] };
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { other: otherServer } }, null, 2) + "\n");
    mkdirSync(path.dirname(settingsFile));
    const originalSettings = { permissions: { allow: ["Bash(ls:*)"] }, enabledMcpjsonServers: ["other"] };
    writeFileSync(settingsFile, JSON.stringify(originalSettings, null, 2) + "\n");

    tmb(["init"], project);
    tmb(["onboard", "--yes"], project);
    expect(existsSync(path.join(project, ".tmb", "trajectory.db"))).toBe(true);
    expect(readJson(mcpFile).mcpServers).toEqual({
      other: otherServer,
      tmb: { command: process.execPath, args: [CLI, "mcp", "--host", "claude-code"] },
    });
    const settings = readJson(settingsFile);
    expect(settings.permissions).toEqual(originalSettings.permissions);
    expect(settings.enabledMcpjsonServers).toEqual(["other", "tmb"]);
    expect(settings.hooks.SessionStart).toEqual(["session-start-role", "session-start"].map((name) => ({ hooks: [{ type: "command", command: `"${process.execPath}" "${CLI}" hook ${name}` }] })));
    // The Human made .mcp.json, so it stays tracked; tmb's own files are ignored.
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe(".tmb/\n.claude/settings.local.json\n");

    const files = [mcpFile, settingsFile, path.join(project, ".gitignore")];
    const before = files.map((file) => readFileSync(file, "utf8"));
    tmb(["init"], project);
    tmb(["onboard", "--yes"], project);
    expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);

    const removed = human(["remove", path.basename(project)], project);
    expect(readJson(mcpFile)).toEqual({ mcpServers: { other: otherServer } });
    expect(readJson(settingsFile)).toEqual(originalSettings);
    expect(existsSync(path.join(project, ".tmb", "trajectory.db"))).toBe(true);
    expect(removed.split("\n").filter((line) => line.startsWith("Kept the record"))).toHaveLength(1);
  });

  test("on a fresh project, remove deletes the files init created", () => {
    const project = newGitProject();
    tmb(["init"], project);
    tmb(["onboard", "--yes"], project);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe(".tmb/\n.mcp.json\n.claude/settings.local.json\n");
    human(["remove", path.basename(project)], project);
    expect(existsSync(path.join(project, ".mcp.json"))).toBe(false);
    expect(existsSync(path.join(project, ".claude"))).toBe(false);
    expect(existsSync(path.join(project, ".tmb", "trajectory.db"))).toBe(true);
  });
});

describe("tool server", () => {
  test("answers initialize, lists every tool and runs each one", async () => {
    const project = newGitProject();
    tmb(["init"], project);
    tmb(["onboard", "--yes"], project);
    const client = await connect(project);
    try {
      expect(client.getServerVersion()?.name).toBe("tmb");
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOLS].sort());
      for (const tool of tools) {
        expect(tool.description?.length ?? 0).toBeGreaterThan(40);
        expect(Object.keys(tool.inputSchema.properties ?? {})).toContain("role");
      }

      const byWorker = await call(client, "issue_create", { title: "Served issue", role: "worker" });
      expect(byWorker.isError).toBe(true);
      expect(byWorker.content[0]?.text).toContain("the worker may not record an issue (issue.create)");
      const issue = await callJson(client, "issue_create", { title: "Served issue", body: "From the tool server", role: "planner" });
      expect(issue.createdBy).toEqual({ kind: "agent", role: "planner", host: "test" });
      expect((await callJson<any>(client, "issue_list", {})).issues.map((summary: { id: string }) => summary.id)).toEqual([issue.id]);
      const decision = await callJson(client, "discussion_append", { issue_id: issue.id, kind: "decision", body: "Serve over stdio" });
      expect(decision.createdBy).toEqual({ kind: "agent", role: "planner", host: "test" });
      expect((await callJson(client, "issue_get", { id: issue.id })).newestDecision.id).toBe(decision.id);
      expect((await callJson(client, "issue_update", { id: issue.id, milestone: "Level 1" })).changed).toEqual(["milestone"]);
      expect((await callJson<any[]>(client, "search", { query: "stdio" }))[0].id).toBe(decision.id);
      expect((await callJson<any[]>(client, "history", { id: issue.id })).map((event) => event.type)).toEqual(["created", "updated"]);

      const refused = await call(client, "issue_create", { title: "x", role: "boss" });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]?.text).toContain("the boss may not record an issue (issue.create)");
      const human = await call(client, "issue_list", { role: "human" });
      expect(human.isError).toBe(true);
      expect(human.content[0]?.text).toContain("role must be planner, worker, reviewer or a role the project created");
      const invalid = await call(client, "issue_list", { state: "done" });
      expect(invalid.isError).toBe(true);
      expect(invalid.content[0]?.text).toContain("state must be one of open, closed, all");
    } finally {
      await client.close();
    }
  });

  test("tells the agent to run tmb init when the project has no record", async () => {
    const project = newGitProject();
    const client = await connect(project);
    try {
      const result = await call(client, "issue_list", {});
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("tmb init");
    } finally {
      await client.close();
    }
  });

  test("names the cause when the record cannot be read", async () => {
    const project = newGitProject();
    mkdirSync(path.join(project, ".tmb"));
    writeFileSync(path.join(project, ".tmb", "trajectory.db"), "not a database, just text long enough for a header");
    const client = await connect(project);
    try {
      const result = await call(client, "issue_list", {});
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("is not a readable SQLite database");
    } finally {
      await client.close();
    }
  });
});

describe("command line", () => {
  test("reads the record an agent writes, and keeps no command that writes an issue", async () => {
    const project = newGitProject();
    tmb(["init"], project);
    tmb(["onboard", "--yes"], project);

    const client = await connect(project);
    let id: string;
    try {
      id = (await callJson(client, "issue_create", { title: "Command line issue", body: "Written by the planner", milestone: "Level 1" })).id;
      await callJson(client, "discussion_append", { issue_id: id, kind: "decision", body: "Pick the plain way" });
    } finally {
      await client.close();
    }
    expect(tmb(["issue", "list"], project)).toContain(`${id}  open    Command line issue  [Level 1]`);
    expect(tmbJson(["issue", "list", "--state", "closed"], project)).toEqual({ issues: [], total: 0 });
    const shown = tmbJson(["issue", "show", id], project);
    expect(shown.issue.createdBy).toEqual({ kind: "agent", role: "planner", host: "test" });
    expect(shown.newestDecision.body).toBe("Pick the plain way");
    expect(tmb(["issue", "show", id], project)).toContain("Decision in force: Pick the plain way");

    expect(tmb(["search", "plain"], project)).toContain(id);
    expect(tmbJson<any[]>(["search", "plain"], project)[0].issueId).toBe(id);
    expect(tmbJson<any[]>(["history", id], project).map((event) => event.data.state ?? "created")).toEqual(["created"]);

    // The planner writes issues, notes, features and tasks with its tools; the Human reads them.
    for (const args of [["issue", "create", "x"], ["issue", "close", id], ["issue", "reopen", id], ["note", id, "x"], ["feature", "start", "feat/x"], ["task", "close", "T-1"]]) {
      expect(run(args, project).status).toBe(2);
    }
  });

  test("refuses bad input with what is allowed, and a project with no record", () => {
    const project = newGitProject();
    const missing = run(["issue", "list"], project);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("tmb init");

    tmb(["init"], project);
    tmb(["onboard", "--yes"], project);
    const badState = run(["issue", "list", "--state", "done"], project);
    expect(badState.status).toBe(1);
    expect(badState.stderr).toContain("state must be one of open, closed, all");
    const badOffset = run(["issue", "list", "--offset", "two"], project);
    expect(badOffset.status).toBe(2);
    expect(badOffset.stderr).toContain("--offset takes a whole number, got two");
    const badFlag = run(["issue", "list", "--colour", "red"], project);
    expect(badFlag.status).toBe(2);
    expect(badFlag.stderr).toContain("--colour");
  });
});

describe("one record, two doors", () => {
  test("a record written through one door reads back through the other", async () => {
    const project = newGitProject();
    tmb(["init"], project);
    tmb(["onboard", "--yes"], project);
    const client = await connect(project);
    let created: any;
    let agentNote: any;
    try {
      created = await callJson(client, "issue_create", { title: "Written by an agent" });
      const detail = await callJson(client, "issue_get", { id: created.id });
      expect(detail.issue).toMatchObject({ title: "Written by an agent", createdBy: { kind: "agent", role: "planner" } });
      agentNote = await callJson(client, "discussion_append", { issue_id: created.id, kind: "note", body: "Written by an agent", role: "planner" });
    } finally {
      await client.close();
    }

    const shown = tmbJson(["issue", "show", created.id], project);
    expect(shown.discussions).toEqual([agentNote]);
    expect(shown.discussions[0].createdBy).toEqual({ kind: "agent", role: "planner", host: "test" });
  });
});

describe("session start", () => {
  test("lists an open issue and its decision", async () => {
    const project = newGitProject();
    tmb(["init"], project);
    tmb(["onboard", "--yes"], project);
    const client = await connect(project);
    let created: any;
    try {
      created = await callJson(client, "issue_create", { title: "Resume this next session" });
      await callJson(client, "discussion_append", { issue_id: created.id, kind: "decision", body: "Start with the doors" });
    } finally {
      await client.close();
    }

    // init wires two hooks to the session start, so the role and the project's state are two texts.
    const [role, work] = ["session-start-role", "session-start"].map((name) => {
      const result = run(["hook", name], scratch, JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: project }));
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
    }) as [string, string];
    expect(role).toMatch(/^# You are bro\b/);
    expect(work).toStartWith("## Open work in the record");
    expect(work).toContain(`${created.id} Resume this next session`);
    expect(work).toContain("Start with the doors");
  });
});
