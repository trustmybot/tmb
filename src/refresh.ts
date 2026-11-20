// After an update, a project's host files catch up by themselves (trustmybot/tmb#128). The
// record keeps the program and version that last wired the project; when a session starts under
// the same program at another version, newer or older, tmb redoes init's wiring for each host the
// project is set up for, and git's push hook. That wiring replaces only what tmb wrote and leaves
// the Human's own entries alone; it asks nothing and changes no setting. It waits while a task is
// open, leaves a project tied to another program to the Human's `tmb init`, and never fails the
// session: it says what failed and names `tmb init`.
import type { HostAdapter } from "./adapters/index.ts";
import { installPushGate, openProjectStore, type ProgramTie, readSettings, tiedProgram, tieProgram } from "./engine/index.ts";
import type { Actor } from "./engine/store/index.ts";

/** The refresh is tmb's own step, on the Human's behalf: the update was theirs, as is the tie init records. */
const HUMAN: Actor = { kind: "human" };

/** The audit entry each refresh leaves: from which version to which, and what changed. */
export const REFRESH_AUDIT = "host-refresh";

export type RefreshOptions = {
  projectDir: string;
  /** The program running this session start. */
  program: { name: string; version: string };
  /** The command that runs this tmb, which the wiring calls, as init's. */
  tmbCommand: readonly string[];
  /** The hosts tmb knows; the project's own come from its settings. */
  adapters: readonly HostAdapter[];
};

/** A wiring line that says nothing changed. The adapters and the push gate end those this way. */
const UNCHANGED = /(?:nothing to (?:add|change|remove)\.|already holds the record; kept it\.|already runs the push gate\.)$/;

/** What a refresh found to do, read from the record before anything is written. */
type Plan = { kind: "none" } | { kind: "wait"; from: ProgramTie } | { kind: "refresh"; from: ProgramTie; hosts: HostAdapter[] };

function planOf(options: RefreshOptions): Plan {
  const opened = openProjectStore(options.projectDir, { create: false });
  // No record, or one this tmb cannot open: there is nothing to refresh, and session start names a bad record itself.
  if (!opened.ok) return { kind: "none" };
  try {
    const from = tiedProgram(opened.store);
    if (from === null || from.program !== options.program.name || from.version === options.program.version) return { kind: "none" };
    if (opened.store.listTasks("open").length > 0) return { kind: "wait", from };
    const settings = readSettings(opened.store);
    const ids = new Set([...Object.keys(settings.host_roles ?? {}), ...(settings.host === null ? [] : [settings.host])]);
    return { kind: "refresh", from, hosts: options.adapters.filter((adapter) => ids.has(adapter.id)) };
  } finally {
    opened.store.close();
  }
}

function oneLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
}

function listed(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * Brings the project's host files to the running program when an earlier or later version of it
 * wired them. Returns the one line the session start says, or null when there was nothing to do.
 * Never throws.
 */
export function refreshProject(options: RefreshOptions): string | null {
  const { projectDir, program, tmbCommand } = options;
  let plan: Plan;
  try {
    plan = planOf(options);
  } catch (error) {
    return `tmb could not check whether this project's host files match ${program.name} ${program.version}: ${oneLine(error)}. Run \`${program.name} init\` to wire it again.`;
  }
  if (plan.kind === "none") return null;
  const { from } = plan;
  const span = `from ${program.name} ${from.version} to ${program.version}`;
  if (plan.kind === "wait") {
    return `This project's host files are still ${program.name} ${from.version}'s, and ${program.version} runs now: tmb refreshes them at the first session start with no task open.`;
  }
  try {
    const lines = [...plan.hosts.flatMap((adapter) => adapter.setup(projectDir, tmbCommand)), ...installPushGate(projectDir, tmbCommand)];
    const changed = lines.filter((line) => !UNCHANGED.test(line));
    const opened = openProjectStore(projectDir, { create: false });
    if (!opened.ok) throw new Error(opened.error.message);
    try {
      opened.store.recordAudit(HUMAN, {
        what: REFRESH_AUDIT,
        detail: JSON.stringify({ program: program.name, from: from.version, to: program.version, hosts: plan.hosts.map((adapter) => adapter.id), changed }),
      });
      tieProgram(opened.store, HUMAN, { program: program.name, version: program.version, command: [...tmbCommand] });
    } finally {
      opened.store.close();
    }
    const what = changed.length === 0 ? "nothing in them needed to change" : `${changed.length} change${changed.length === 1 ? "" : "s"}, kept in the record`;
    const hosts = plan.hosts.length === 0 ? "The host reads" : `${listed(plan.hosts.map((adapter) => adapter.name))} ${plan.hosts.length === 1 ? "reads" : "read"}`;
    return `tmb refreshed this project's host files ${span}: ${what}. ${hosts} them when a session starts, so the refresh takes effect from the next session.`;
  } catch (error) {
    return `tmb could not refresh this project's host files ${span}: ${oneLine(error)}. Run \`${program.name} init\` to wire it again.`;
  }
}
