// The tmb program a project is tied to: the one whose init last wired it. Its hooks, its tool
// server and git's push hook call that program, so a project initialised with tmb-dev always
// runs dev (trustmybot/tmb#89). The tie is kept in the record's audit trail like a setting, so
// every move from one program to another is recorded.
import type { Actor, Store } from "./store/index.ts";

const AUDIT_WHAT = "program";

/** A project's program: its name, the version that tied it, and the command its wiring runs. */
export type ProgramTie = { program: string; version: string; command: string[] };

/** The program the project is tied to; null for a project wired before ties were recorded. */
export function tiedProgram(store: Store): ProgramTie | null {
  const entry = store.newestAudit(AUDIT_WHAT);
  if (!entry) return null;
  const tie = JSON.parse(entry.detail) as Partial<ProgramTie>;
  if (typeof tie.program !== "string" || typeof tie.version !== "string" || !Array.isArray(tie.command)) return null;
  return { program: tie.program, version: tie.version, command: tie.command.map(String) };
}

/**
 * Ties the project to `tie`, recording it when the program or its command differs from the
 * tie in force. Returns the tie it replaced, or null when there was none.
 */
export function tieProgram(store: Store, actor: Actor, tie: ProgramTie): { changed: boolean; from: ProgramTie | null } {
  const from = tiedProgram(store);
  const same = from !== null && from.program === tie.program && JSON.stringify(from.command) === JSON.stringify(tie.command);
  if (same) return { changed: false, from };
  store.recordAudit(actor, { what: AUDIT_WHAT, detail: JSON.stringify(tie) });
  return { changed: true, from };
}
