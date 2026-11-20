import type { FeedbackEnv, SubagentRole, TmbEventType } from "../engine/index.ts";

/** Whether the host is installed on this machine, and its version when it says. */
export type HostDetection = { installed: boolean; version?: string };

/** What the host can do, so the engine can fall back or refuse where it cannot. */
export type HostLimits = {
  /** The host asks before a tool call and obeys a deny. */
  canDenyToolCall: boolean;
  /** The host runs each subagent role on the model its role file names. */
  modelPerRole: boolean;
  /**
   * The host says which agent makes each tool call. When it does not, a subagent's call is
   * judged under the role the host was set up with, so a worker's write cannot be told from
   * the planner's; git's pre-push hook still judges every push.
   */
  namesAgentOnToolCall: boolean;
  /** The tmb events the host raises. */
  events: readonly TmbEventType[];
};

/** What whoever started this tmb said about the run, as the command line read it. */
export type HookRun = {
  /** No one can answer in the run. */
  unattended: boolean;
  /** The feedback program's environment, so a first session can tell the Human about it once. */
  feedback?: FeedbackEnv;
  /**
   * At a session start: brings the project's host files to the running tmb when another version of
   * it wired them, and returns the one line the session start says, or null. Never throws.
   */
  refresh?: (projectDir: string) => string | null;
  /**
   * At a planner's session start: the one line on what \`tmb doctor\` would find, or null when it
   * finds nothing (trustmybot/tmb#160). Never throws.
   */
  doctor?: (projectDir: string) => string | null;
};

/** What every host adapter gives the command line. */
export interface HostAdapter {
  /** The host's id: what `--host` takes and what the record stores as the project's host. */
  id: string;
  /** The host's display name. */
  name: string;
  /** The program the Human runs to start the host in a project, such as `claude`. */
  command: string;
  limits: HostLimits;
  /** Looks for the host's program; `searchPath` replaces PATH for the lookup. Never throws. */
  detect(searchPath?: string): HostDetection;
  /**
   * Wires the host to tmb in the project; returns what changed, one line each. `tmbCommand`
   * runs this tmb: its executable, then its entry file when it runs from source. `roles` are
   * the subagent roles to write, the engine's list unless given.
   */
  setup(projectDir: string, tmbCommand: readonly string[], roles?: readonly SubagentRole[]): string[];
  /** Undoes exactly what init added; returns what changed, one line each. */
  remove(projectDir: string): string[];
  /**
   * What the Human must still do in the host before it runs tmb in the project, such as trust
   * the project or tmb's hooks, one step each; none when nothing is left. tmb never does these itself.
   */
  pendingSteps?(projectDir: string): string[];
  /**
   * What `tmb doctor` finds different from what `setup` would write with `tmbCommand`, one line
   * each; none when init would change nothing. Reads only.
   */
  wiringGaps?(projectDir: string, tmbCommand: readonly string[]): string[];
  /** Answers a host event: the host's stdin in, the host's stdout out (empty when there is nothing to say). Throws on bad input. */
  answerHook(event: string, stdinText: string, run: HookRun): string;
}
