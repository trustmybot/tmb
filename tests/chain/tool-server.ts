// The tool server as a host's agent reaches it: `tmb mcp --host claude-code`, spoken to over
// stdio in JSON-RPC, one message per line. The chain reads the code graph and tries the
// planner's own steps through it, the door bro uses, with no model. Uses only bun, so it runs in
// the container with no package installed.
import { PROGRAM, type World } from "./world.ts";

export type ToolAnswer = { ok: boolean; text: string; json: unknown };

/**
 * Starts one tool server in the project, calls each tool in turn and stops it. `env` adds to
 * the chain's environment, such as TMB_UNATTENDED for a run no one is there to answer.
 */
export async function callTools(world: World, calls: { name: string; args: Record<string, unknown> }[], env: Record<string, string> = {}): Promise<ToolAnswer[]> {
  const child = Bun.spawn([PROGRAM, "mcp", "--host", "claude-code"], {
    cwd: world.project,
    env: world.env(env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const messages: unknown[] = [
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tmb-chain", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    ...calls.map((call, index) => ({ jsonrpc: "2.0", id: index + 1, method: "tools/call", params: { name: call.name, arguments: call.args } })),
  ];
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  await child.stdin.flush();

  const answers = new Map<number, ToolAnswer>();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Bun.sleep(120_000).then(() => "timeout" as const);
  try {
    while (answers.size < calls.length) {
      const read = await Promise.race([reader.read(), deadline]);
      if (read === "timeout" || read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line === "") continue;
        const message = JSON.parse(line) as { id?: number; result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message: string } };
        if (typeof message.id !== "number" || message.id === 0) continue;
        const text = message.error?.message ?? message.result?.content?.map((part) => part.text ?? "").join("") ?? "";
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          // A refusal or a plain answer is text.
        }
        answers.set(message.id, { ok: message.error === undefined && message.result?.isError !== true, text, json });
      }
    }
  } finally {
    child.kill();
    await child.exited;
  }
  const all = calls.map((call, index) => answers.get(index + 1) ?? { ok: false, text: `the tool server gave no answer to ${call.name}`, json: null });
  calls.forEach((call, index) => world.printed.push({ run: `tool ${call.name}`, text: all[index]!.text }));
  return all;
}
