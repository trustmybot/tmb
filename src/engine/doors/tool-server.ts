// The tool server: the way into the engine for agents. Each record operation is one tool
// with the operation's name and input schema, plus the caller's role. Speaks MCP over stdio.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { HandlerError, isOperationName, OPERATIONS } from "../handlers/index.ts";
import { openProjectStore } from "../project.ts";
import { hostRole } from "../settings.ts";
import { type Actor, ROLES, type Role, type Store } from "../store/index.ts";

export const SERVER_NAME = "tmb";
const ROLE_FIELD = {
  type: "string",
  description: `Your role in tmb's workflow: ${ROLES.join(", ")}. Defaults to the role this host was set up in, the planner unless init or onboard named another; a worker or a reviewer subagent passes its own.`,
  enum: ROLES,
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
  ) {
    if (host.trim() === "") throw new Error("the tool server needs a host id");
  }

  /** Opens the record on first use, and again after a failure, so a record set up later is found. */
  private openStore(): Store {
    if (this.store) return this.store;
    const opened = openProjectStore(this.projectDir, { create: false });
    if (!opened.ok) {
      if (opened.error.failure === "missing") {
        throw new Error(`There is no tmb record in ${this.projectDir}: run \`tmb init\` in the project first, then try again.`);
      }
      throw new Error(`tmb cannot use the record: ${opened.error.message}`);
    }
    this.store = opened.store;
    return this.store;
  }

  async call(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    if (!isOperationName(name)) return textResult(`unknown tool ${name}; the tools are ${Object.keys(OPERATIONS).join(", ")}`, true);
    const { role, ...input } = args ?? {};
    if (role !== undefined && !ROLES.includes(role as Role)) return textResult(`role must be one of ${ROLES.join(", ")}, got ${JSON.stringify(role)}`, true);
    try {
      const store = this.openStore();
      const actor: Actor = { kind: "agent", role: (role as Role | undefined) ?? hostRole(store, this.host), host: this.host };
      const result = await OPERATIONS[name].run(store, actor, input, { projectDir: this.projectDir, unattended: this.unattended });
      return textResult(JSON.stringify(result));
    } catch (error) {
      return textResult(error instanceof HandlerError ? error.message : describe(error), true);
    }
  }

  close(): void {
    this.store?.close();
    this.store = null;
  }
}

/** Serves the tools on stdin and stdout until stdin closes. */
export async function serveTools(options: { projectDir: string; host: string; version: string; unattended?: boolean }): Promise<void> {
  const session = new ToolSession(options.projectDir, options.host, options.unattended === true);
  const server = new Server({ name: SERVER_NAME, version: options.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => session.call(request.params.name, request.params.arguments));

  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  // The stdio transport stops reading at stdin's end but does not report it; close here.
  process.stdin.once("end", () => void server.close());
  await server.connect(new StdioServerTransport());
  await closed;
  session.close();
}
