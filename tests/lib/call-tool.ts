// One tool call on a project's tool server, as its own process, so a synchronous test can make
// the call an agent makes: `bun call-tool.ts <tmb> <project> <tool> <json-arguments>`, where <tmb>
// is tmb's source entry point or a built tmb. Prints the tool's answer as JSON: { isError, text }.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolResult } from "./tmb-processes.ts";

const [cli, project, tool, json] = process.argv.slice(2);

function serverCommand(tmb: string, args: string[]): { command: string; args: string[] } {
  return tmb.endsWith(".ts") ? { command: process.execPath, args: [tmb, ...args] } : { command: tmb, args };
}
const client = new Client({ name: "tmb-call-tool", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({ ...serverCommand(cli!, ["mcp", "--host", "test", "--project", project!]), env: process.env as Record<string, string>, stderr: "pipe" }),
);
const result = (await client.callTool({ name: tool!, arguments: JSON.parse(json!) })) as ToolResult;
await client.close();
process.stdout.write(JSON.stringify({ isError: result.isError === true, text: result.content[0]?.text ?? "" }));
