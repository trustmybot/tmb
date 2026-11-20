// What the shared adapter tests need to know about one host: how to fake its program, how it
// runs a hook setup wired and with what input, how it reads tmb's answer, and where setup
// registered the tool server. Everything else in the suite is the same for every host.
import type { HostAdapter } from "../../../src/adapters/index.ts";

/**
 * A host-neutral event the suite raises through the host's own hook. The role is the agent's the
 * event comes from: "planner" is the host's main agent, any other role a subagent of that role.
 */
export type ContractEvent =
  | { type: "session-start" }
  | { type: "session-end" }
  | { type: "before-file-write"; role: string; file: string }
  | { type: "before-command"; role: string; command: string }
  | { type: "before-agent-start"; role: string; prompt: string }
  | { type: "after-agent-stop"; role: string }
  | { type: "worker-in-folder"; task: string; folder: string };

/** One hook run as the host would run it: a shell command from the host's config, its stdin, and the variables the host sets. */
export type HookCall = { command: string; input: string; env?: Record<string, string> };

/** tmb's answer as the host reads it. */
export type HookAnswer = { deny: string | null; context: string | null };

export type HostHarness = {
  adapter: HostAdapter;
  /** Makes a program that answers --version as the host does, in a new folder under `dir`; returns that folder. */
  fakeHost(dir: string): string;
  /** Writes the Human's own config for the host into the project, so remove must keep it. */
  seedHumanFiles(project: string): void;
  /** How the host runs the hook setup wired for the event, or null when the host raises no such event. */
  hookCall(project: string, event: ContractEvent): HookCall | null;
  /** Reads the hook's stdout as the host would. */
  readAnswer(event: ContractEvent, stdout: string): HookAnswer;
  /** The tool server command setup registered. */
  toolServer(project: string): { command: string; args: string[] };
};
