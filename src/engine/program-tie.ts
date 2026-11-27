// The tmb program a project is tied to: the one whose init last wired it. Its hooks, its tool
// server and git's push hook call that program, so a project initialised with tmb-dev always
// runs dev (trustmybot/tmb#89). The tie is kept in the record like a setting, under the key
// `program`, so every move from one program to another is recorded; each row holds the whole tie,
// so the newest is the tie in force (trustmybot/tmb#408).
import type { Actor, EntryDetail, Store } from "./store/index.ts";

const KEY = "program";

/** A project's program: its name, the version that tied it, and the command its wiring runs. */
export type ProgramTie = { program: string; version: string; command: string[] };

/** The program the project is tied to; null for a project wired before ties were recorded. */
export function tiedProgram(store: Store): ProgramTie | null {
  const change = store.newestSettingChange(KEY, null, true);
  if (change === null) return null;
  const tie = JSON.parse(change.newValue!) as Partial<ProgramTie>;
  if (typeof tie.program !== "string" || typeof tie.version !== "string" || !Array.isArray(tie.command)) return null;
  return { program: tie.program, version: tie.version, command: tie.command.map(String) };
}

/**
 * Ties the project to `tie`, recording it when the program, its version or its command differs
 * from the tie in force, so the record names the version that last wired the project. `detail`
 * is what the change keeps beside the tie, such as what a refresh changed; given, the change is
 * recorded even when the tie is the same. Returns the tie it replaced, or null when there was none.
 */
export function tieProgram(store: Store, actor: Actor, tie: ProgramTie, detail?: EntryDetail): { changed: boolean; from: ProgramTie | null } {
  const from = tiedProgram(store);
  const same = from !== null && from.program === tie.program && from.version === tie.version && JSON.stringify(from.command) === JSON.stringify(tie.command);
  if (same && detail === undefined) return { changed: false, from };
  store.recordSettingChange(actor, { key: KEY, oldValue: from === null ? null : JSON.stringify(from), newValue: JSON.stringify(tie), detail });
  return { changed: !same, from };
}

/**
 * Records that a running session moved to a newer build. A move wires nothing, so the tie in
 * force stays: the row holds it unchanged, and the refresh that follows ties the new version.
 */
export function recordProgramMove(store: Store, actor: Actor, move: { program: string; from: string; to: string }): void {
  const tie = tiedProgram(store);
  const value = tie === null ? null : JSON.stringify(tie);
  store.recordSettingChange(actor, { key: KEY, oldValue: value, newValue: value, detail: { moved: move } });
}
