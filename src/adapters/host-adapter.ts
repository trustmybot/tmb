// What the command line asks of a host, whichever it is. An adapter implements this and keeps its
// host's files, formats and numbers to itself: nothing outside src/adapters names them.
import type { FeedbackEnv, ModelUsage, SubagentRole, TmbEventType } from "../engine/index.ts";

/** Whether the host is installed on this machine, and its version when it says. */
export type HostDetection = { readonly installed: boolean; readonly version?: string };

/** What the host can do, so the engine can fall back or refuse where it cannot. */
export type HostLimits = {
  /** The host asks before a tool call and obeys a deny. */
  readonly canDenyToolCall: boolean;
  /** The host runs each subagent role on the model its role file names. */
  readonly modelPerRole: boolean;
  /**
   * The host says which agent makes each tool call. When it does not, a subagent's call is
   * judged under the role the host was set up with, so a worker's write cannot be told from
   * the planner's; git's pre-push hook still judges every push.
   */
  readonly namesAgentOnToolCall: boolean;
  /** The tmb events the host raises. */
  readonly events: readonly TmbEventType[];
};

/** The host's cap on one text a hook gives a session, in characters, and the budget tmb fits each session-start text to, below the cap. */
export type SessionTextLimit = { readonly cap: number; readonly budget: number };

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
  readonly id: string;
  /** The host's display name. */
  readonly name: string;
  /** The program the Human runs to start the host in a project, such as `claude`. */
  readonly command: string;
  readonly limits: HostLimits;
  /** How long a session-start text may be; absent when the host states no cap. */
  readonly sessionText?: SessionTextLimit;
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
   * Makes the host link the project's shared folders, paths inside the repo, from the main folder
   * into every worktree it makes, keeping the Human's own entries; an empty list takes tmb's away.
   * `remove` takes them away too. Returns what changed, one line each.
   */
  shareFolders?(projectDir: string, folders: readonly string[]): string[];
  /**
   * What `tmb doctor` finds different from what `setup` and `shareFolders` would write with
   * `tmbCommand` and `sharedFolders`, one line each; none when they would change nothing. Reads only.
   */
  wiringGaps?(projectDir: string, tmbCommand: readonly string[], sharedFolders?: readonly string[]): string[];
  /** Answers a host event: the host's stdin in, the host's stdout out (empty when there is nothing to say). Throws on bad input. */
  answerHook(event: string, stdinText: string, run: HookRun): string;
  /** What the Human does in this host to restart tmb's tool server in a running session, in the host's own words. */
  readonly reconnectToolServer: string;
  /** The title the Human gave the session, from a session start's input, when the host passes it; null otherwise. Never throws. */
  sessionTitle?(stdinText: string): string | null;
  /** The tokens per model a subagent's transcript holds, or null when the host keeps none tmb can read. Never throws. */
  readUsage?(transcriptFile: string | undefined): ModelUsage[] | null;
}
