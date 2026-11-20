// Both ways into the record, driven as separate processes the way a host and the Human use
// them: init, onboard and remove, the tool server over stdio, the record commands, and session start.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathWithFakeClaude } from "./fake-host.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const ROOT = path.resolve(import.meta.dir, "../..");
const CLI = path.join(ROOT, "src", "cli.ts");
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
    expect(settings.hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: `"${process.execPath}" "${CLI}" hook session-start` }] }]);
    // The Human made .mcp.json, so it stays tracked; tmb's own files are ignored.
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe(".tmb/\n.claude/settings.local.json\n");

    const files = [mcpFile, settingsFile, path.join(project, ".gitignore")];
    const before = files.map((file) => readFileSync(file, "utf8"));
    tmb(["init"], project);
    tmb(["onboard", "--yes"], project);
    expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);

    const removed = tmb(["remove"], project);
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
    tmb(["remove"], project);
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

      const issue = await callJson(client, "issue_create", { title: "Served issue", body: "From the tool server", role: "worker" });
      expect(issue.createdBy).toEqual({ kind: "agent", role: "worker", host: "test" });
      expect((await callJson<any[]>(client, "issue_list", { state: "open" })).map((summary) => summary.id)).toEqual([issue.id]);
      const decision = await callJson(client, "discussion_append", { issue_id: issue.id, kind: "decision", body: "Serve over stdio" });
      expect(decision.createdBy).toEqual({ kind: "agent", role: "planner", host: "test" });
      expect((await callJson(client, "issue_get", { id: issue.id })).newestDecision.id).toBe(decision.id);
      expect((await callJson(client, "issue_update", { id: issue.id, milestone: "Level 1" })).changed).toEqual(["milestone"]);
      expect((await callJson<any[]>(client, "search", { query: "stdio" }))[0].id).toBe(decision.id);
      expect((await callJson<any[]>(client, "history", { id: issue.id })).map((event) => event.type)).toEqual(["created", "updated"]);

      const refused = await call(client, "issue_create", { title: "x", role: "boss" });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]?.text).toContain("role must be one of planner, worker, reviewer");
      const invalid = await call(client, "issue_list", { state: "done" });
      expect(invalid.isError).toBe(true);
      expect(invalid.content[0]?.text).toContain("state must be one of open, closed");
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
  test("runs each record command as the Human", () => {
    const project = newGitProject();
    tmb(["init"], project);
    tmb(["onboard", "--yes"], project);

    const created = tmb(["issue", "create", "Command", "line", "issue", "--body", "Typed by hand", "--milestone", "Level 1"], project);
    const id = /Created issue (\S+): Command line issue/.exec(created)?.[1];
    expect(id).toBeDefined();
    expect(tmb(["issue", "list"], project)).toContain(`${id}  open    Command line issue  [Level 1]`);
    expect(tmbJson(["issue", "list", "--state", "closed"], project)).toEqual([]);

    expect(tmb(["note", id!, "Pick", "the", "plain", "way", "--decision"], project)).toContain(`Added a decision to issue ${id}`);
    const shown = tmbJson(["issue", "show", id!], project);
    expect(shown.issue.createdBy).toEqual({ kind: "human" });
    expect(shown.newestDecision.body).toBe("Pick the plain way");
    expect(tmb(["issue", "show", id!], project)).toContain("Decision in force: Pick the plain way");

    expect(tmb(["search", "plain"], project)).toContain(id!);
    expect(tmbJson<any[]>(["search", "plain"], project)[0].issueId).toBe(id);

    expect(tmb(["issue", "close", id!], project)).toContain(`Closed issue ${id}`);
    expect(tmb(["issue", "close", id!], project)).toContain("already closed");
    expect(tmb(["issue", "reopen", id!.toLowerCase()], project)).toContain(`Reopened issue ${id}`);
    expect(tmbJson<any[]>(["history", id!], project).map((event) => event.data.state ?? "created")).toEqual(["created", "closed", "open"]);
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
    expect(badState.stderr).toContain("state must be one of open, closed");
    const badFlag = run(["issue", "create", "x", "--colour", "red"], project);
    expect(badFlag.status).toBe(2);
    expect(badFlag.stderr).toContain("--colour");
    const noTitle = run(["issue", "create"], project);
    expect(noTitle.status).toBe(2);
    expect(noTitle.stderr).toContain("missing title");
  });
});

describe("one record, two doors", () => {
  test("a record written through one door reads back through the other", async () => {
    const project = newGitProject();
    tmb(["init"], project);
    tmb(["onboard", "--yes"], project);
    const created = tmbJson(["issue", "create", "Written on the command line"], project);

    const client = await connect(project);
    let agentNote: any;
    try {
      const detail = await callJson(client, "issue_get", { id: created.id });
      expect(detail.issue).toMatchObject({ title: "Written on the command line", createdBy: { kind: "human" } });
      agentNote = await callJson(client, "discussion_append", { issue_id: created.id, kind: "note", body: "Written by an agent", role: "reviewer" });
    } finally {
      await client.close();
    }

    const shown = tmbJson(["issue", "show", created.id], project);
    expect(shown.discussions).toEqual([agentNote]);
    expect(shown.discussions[0].createdBy).toEqual({ kind: "agent", role: "reviewer", host: "test" });
  });
});

describe("session start", () => {
  test("lists an issue created through the command line", () => {
    const project = newGitProject();
    tmb(["init"], project);
    tmb(["onboard", "--yes"], project);
    const created = tmbJson(["issue", "create", "Resume this next session"], project);
    tmb(["note", created.id, "Start with the doors", "--decision"], project);

    const result = run(["hook", "session-start"], scratch, JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: project }));
    expect(result.status).toBe(0);
    const context: string = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(context).toMatch(/^# You are bro\b/);
    const work = context.slice(context.indexOf("## Open work in the record"));
    expect(work).toContain(`${created.id} Resume this next session`);
    expect(work).toContain("Start with the doors");
  });
});
