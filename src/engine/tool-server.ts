// The tool server: the way into the engine for agents. Each record operation is one tool
// with the operation's name and input schema, plus the caller's role. Speaks MCP over stdio.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { runningName } from "./program.ts";
import type { FeedbackEnv } from "./feedback/index.ts";
import type { RemoteIssueWriter } from "./handlers/common.ts";
import { HandlerError, isOperationName, OPERATIONS } from "./handlers/index.ts";
import { openProjectStore } from "./project.ts";
import { HUMAN_ROLE, isRoleName } from "./permissions.ts";
import { type SubagentRole, subagentRolesOf } from "./roles.ts";
import { hostRole, readSettings, sharedFoldersOf } from "./settings.ts";
import { type Actor, ROLES, type Store } from "./store/index.ts";

export const SERVER_NAME = "tmb";
const ROLE_FIELD = {
  type: "string",
  description: `Your role in tmb's workflow: ${ROLES.join(", ")}, or a role the project created. Defaults to the role this host was set up in, the planner unless init or onboard named another; a subagent passes its own.`,
} as const;

export function listTools(): Tool[] {
  return Object.entries(OPERATIONS).map(([name, operation]) => ({
    name,
    description: operation.description,
    inputSchema: {
      ...operation.inputSchema,
      properties: { ...operation.inputSchema.properties, role: ROLE_FIELD },
      required: [...operation.inputSchema.required],
    },
  }));
}

function textResult(text: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: "text", text }], isError } : { content: [{ type: "text", text }] };
}

/**
 * Told the project's shared folders each time a settings_set changes them, so the host's own files
 * catch up: the command line hands it to the host's adapter. The engine names no host.
 */
export type SharedFoldersListener = (projectDir: string, folders: readonly string[]) => void;

/**
 * Told the project's subagent roles each time a role is created or deleted, so the host's agent
 * files catch up: the command line hands it to the host's adapter. The engine names no host.
 */
export type RolesListener = (projectDir: string, roles: readonly SubagentRole[]) => void;

/**
 * Told when the session starts and when the planner reads the record's issues, so the remote's
 * changes can be brought in first: the command line hands it to the syncer. The engine names no
 * remote. A read waits for it at most RECORD_READ_WAIT_MS, then answers from the record as it is.
 */
export type RecordReadListener = (projectDir: string) => Promise<void> | void;

/** The tools that read the record's issues, which a poll of the remote may refresh first. */
const RECORD_READ_TOOLS: readonly string[] = ["issue_list", "issue_get", "search"];
/** The longest a read of the record waits for a poll of the remote. */
export const RECORD_READ_WAIT_MS = 1_500;

/** The reads whose answer says so when a poll of the remote is still running after the wait. */
const LIST_READ_TOOLS: readonly string[] = ["issue_list", "search"];
/** Said after a list or search answered while a poll of the remote, above all a first import, still runs. */
export const SYNC_RUNNING_NOTE = "A sync with the remote is still running, so issues from it may be missing here; ask again shortly.";

/**
 * Waits for the listener's work up to the cap; its failure or its lateness never fails the call.
 * Returns false when the work is still running at the cap.
 */
async function briefly(work: Promise<void> | void): Promise<boolean> {
  if (work === undefined) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), RECORD_READ_WAIT_MS);
  });
  try {
    return await Promise.race([work.then(() => true, () => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The tools whose change to the project's roles reaches the host's agent files. */
const ROLE_TOOLS: readonly string[] = ["role_create", "role_delete"];

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Answers tool calls for one project, acting as an agent of the given host. */
export class ToolSession {
  private store: Store | null = null;

  constructor(
    readonly projectDir: string,
    readonly host: string,
    /** True when no one can answer in the run this server serves. */
    readonly unattended = false,
    /** The feedback program's environment, for the planner's feedback tools. */
    readonly feedback?: FeedbackEnv,
    private readonly onSharedFolders?: SharedFoldersListener,
    private readonly onRoles?: RolesListener,
    private readonly onRecordRead?: RecordReadListener,
    /** Writes a change to a mirrored issue on its remote: the command line hands it the syncer's writer. */
    private readonly remoteIssues?: RemoteIssueWriter,
  ) {
    if (host.trim() === "") throw new Error("the tool server needs a host id");
  }

  /** Opens the record on first use, and again after a failure, so a record set up later is found. */
  private openStore(): Store {
    if (this.store) return this.store;
    const opened = openProjectStore(this.projectDir, { create: false });
    if (!opened.ok) {
      if (opened.error.failure === "missing") {
        throw new Error(`There is no tmb record in ${this.projectDir}: run \`${runningName()} init\` in the project first, then try again.`);
      }
      throw new Error(`tmb cannot use the record: ${opened.error.message}`);
    }
    this.store = opened.store;
    return this.store;
  }

  async call(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    if (!isOperationName(name)) return textResult(`unknown tool ${name}; the tools are ${Object.keys(OPERATIONS).join(", ")}`, true);
    const { role, ...input } = args ?? {};
    if (role !== undefined && (typeof role !== "string" || !isRoleName(role) || role === HUMAN_ROLE)) {
      return textResult(`role must be ${ROLES.join(", ")} or a role the project created, got ${JSON.stringify(role)}`, true);
    }
    const settled = RECORD_READ_TOOLS.includes(name) ? await this.recordRead() : true;
    try {
      const store = this.openStore();
      const actor: Actor = { kind: "agent", role: (role as string | undefined) ?? hostRole(store, this.host), host: this.host };
      const result = await OPERATIONS[name].run(store, actor, input, { projectDir: this.projectDir, unattended: this.unattended, feedback: this.feedback, remoteIssues: this.remoteIssues });
      if (name === "settings_set" && (result as { changed: string[] }).changed.includes("shared_folders")) {
        try {
          this.onSharedFolders?.(this.projectDir, sharedFoldersOf(readSettings(store), null));
        } catch {
          // The setting is recorded either way; tmb doctor's host-files check names a host file left behind.
        }
      }
      if (ROLE_TOOLS.includes(name)) {
        try {
          this.onRoles?.(this.projectDir, subagentRolesOf(store));
        } catch {
          // The role is recorded either way; tmb doctor's host-files check names an agent file left behind.
        }
      }
      const answer = textResult(JSON.stringify(result));
      if (!settled && LIST_READ_TOOLS.includes(name)) answer.content.push({ type: "text", text: SYNC_RUNNING_NOTE });
      return answer;
    } catch (error) {
      return textResult(error instanceof HandlerError ? error.message : describe(error), true);
    }
  }

  /** Tells the listener the record is read; never throws. False while its poll still runs after the wait. */
  async recordRead(): Promise<boolean> {
    try {
      return await briefly(this.onRecordRead?.(this.projectDir));
    } catch {
      // The record answers as it is.
      return true;
    }
  }

  close(): void {
    this.store?.close();
    this.store = null;
  }
}

/** Serves the tools on stdin and stdout until stdin closes. */
export async function serveTools(options: {
  projectDir: string;
  host: string;
  version: string;
  unattended?: boolean;
  feedback?: FeedbackEnv;
  onSharedFolders?: SharedFoldersListener;
  onRoles?: RolesListener;
  onRecordRead?: RecordReadListener;
  remoteIssues?: RemoteIssueWriter;
}): Promise<void> {
  const session = new ToolSession(
    options.projectDir,
    options.host,
    options.unattended === true,
    options.feedback,
    options.onSharedFolders,
    options.onRoles,
    options.onRecordRead,
    options.remoteIssues,
  );
  const server = new Server({ name: SERVER_NAME, version: options.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => session.call(request.params.name, request.params.arguments));

  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  // The stdio transport stops reading at stdin's end but does not report it; close here.
  process.stdin.once("end", () => void server.close());
  await server.connect(new StdioServerTransport());
  // The session starts: a poll of the remote begins in the background and holds up nothing.
  void session.recordRead();
  await closed;
  session.close();
}
