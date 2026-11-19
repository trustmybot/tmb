// The third layer of the gate: git's own pre-push hook asks the engine about every push, an
// agent's or one the Human types. In agile mode a commit reaches the base branch only inside a
// feature branch tip that the reviewer passed or the Human waived, so a push to the base branch
// is refused while it carries a commit no such tip holds, and the base branch is never deleted.
// Every other branch, the feature branches' backups among them, pushes freely: in agile mode
// review comes before the base branch, not before a backup.
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Decision } from "./decide.ts";
import { runGit } from "./git.ts";
import { coveredCommits } from "./handlers/reviews.ts";
import { openProjectStore } from "./project.ts";
import { readSettings } from "./settings.ts";
import type { Actor, Store } from "./store/index.ts";

/** One line git writes to the pre-push hook's stdin. */
export type PushRef = { localRef: string; localSha: string; remoteRef: string; remoteSha: string };

const ZERO_SHA = /^0+$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SHOWN_COMMITS = 10;
/** git cannot say who typed a push, so the gate's decision on one is recorded as the Human's. */
const PUSHER: Actor = { kind: "human" };

/** git's stdin lines `<local-ref> <local-sha> <remote-ref> <remote-sha>`, or null when one is not that shape. */
export function parsePushRefs(stdin: string): PushRef[] | null {
  const refs: PushRef[] = [];
  for (const line of stdin.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) return null;
    const [localRef, localSha, remoteRef, remoteSha] = fields as [string, string, string, string];
    if (!SHA.test(localSha) || !SHA.test(remoteSha)) return null;
    refs.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return refs;
}

function commitOf(projectDir: string, rev: string): string | null {
  const resolved = runGit(projectDir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  return resolved.ok ? resolved.stdout : null;
}

const short = (sha: string): string => sha.slice(0, 12);

/**
 * The commits a push to the base branch brings that no reviewed or waived feature branch tip
 * holds. Commits already on the remote's base branch, or under a feature branch's starting
 * point, are not new. Merge commits are left out: they bring no change of their own to review.
 */
function uncovered(store: Store, projectDir: string, remote: string, base: string, ref: PushRef): { lines: string[]; error: string | null } {
  const known = [
    ZERO_SHA.test(ref.remoteSha) ? null : commitOf(projectDir, ref.remoteSha),
    commitOf(projectDir, `refs/remotes/${remote}/${base}`),
    ...store.listFeatures().map((feature) => commitOf(projectDir, feature.baseCommit)),
    ...coveredCommits(store).map((commit) => commitOf(projectDir, commit)),
  ].filter((sha): sha is string => sha !== null);
  const listed = runGit(projectDir, ["rev-list", "--no-merges", "--format=%h %s", ref.localSha, "--not", ...new Set(known)]);
  if (!listed.ok) return { lines: [], error: `git could not list the commits the push brings: ${listed.stderr || "no reason given"}` };
  const lines = listed.stdout.split("\n").filter((line) => line !== "" && !line.startsWith("commit "));
  return { lines, error: null };
}

function judgeRef(store: Store, projectDir: string, remote: string, base: string, ref: PushRef): string | null {
  if (ref.remoteRef !== `refs/heads/${base}`) return null;
  if (ZERO_SHA.test(ref.localSha)) return `it deletes the base branch ${base} on ${remote}, and tmb never lets the base branch go`;
  const found = uncovered(store, projectDir, remote, base, ref);
  if (found.error !== null) return found.error;
  if (found.lines.length === 0) return null;
  const shown = found.lines.slice(0, SHOWN_COMMITS).map((line) => `  ${line}`);
  if (found.lines.length > SHOWN_COMMITS) shown.push(`  and ${found.lines.length - SHOWN_COMMITS} more`);
  return [
    `it brings ${found.lines.length} commit${found.lines.length === 1 ? "" : "s"} onto the base branch ${base} at ${short(ref.localSha)} that no feature branch tip the reviewer passed, or the Human waived, holds:`,
    ...shown,
    "In agile mode work reaches the base branch through a feature branch: the reviewer passes it at its tip (or the Human runs `tmb feature waive <name> --reason <text>`), then its pull request opens with feature_pr (`tmb feature pr <name> --title <text>`).",
  ].join("\n");
}

function denied(remote: string, why: string): Decision {
  return { decision: "deny", reason: `tmb refused the push to ${remote}: ${why}` };
}

/**
 * Judges a push from git's pre-push hook: `remote` is the remote's name (or address) and `stdin`
 * the ref lines git passed. With no record it allows; a record it cannot read denies. With a
 * readable record the decision is recorded as a guard decision.
 */
export function judgePush(projectDir: string, remote: string, stdin: string): Decision {
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) {
    if (opened.error.failure === "missing") return { decision: "allow" };
    return denied(remote, `tmb cannot read the project's record, so it allows nothing: ${opened.error.message}`);
  }
  const store = opened.store;
  try {
    const refs = parsePushRefs(stdin);
    const base = readSettings(store).base_branch;
    let decision: Decision;
    if (refs === null) decision = denied(remote, "git passed the hook a line that is not `<local-ref> <local-sha> <remote-ref> <remote-sha>`");
    else if (base === null) decision = { decision: "allow", reason: "no base branch is set, so no push is judged" };
    else {
      const why = refs.map((ref) => judgeRef(store, projectDir, remote, base, ref)).find((reason) => reason !== null);
      decision = why === undefined ? { decision: "allow", reason: `no ref of the push brings unreviewed commits onto ${base}` } : denied(remote, why);
    }
    store.appendGuardDecision(PUSHER, {
      event: JSON.stringify({ type: "before-push", raisedBy: "git", remote, refs: refs ?? stdin }),
      decision: decision.decision,
      reason: decision.reason ?? "no rule denies it",
    });
    return decision;
  } catch (error) {
    return denied(remote, `tmb could not judge or record the push: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    store.close();
  }
}

// --- the hook file ------------------------------------------------------------------------

const HOOK_MARK = "# tmb: the push gate.";

function hookPath(projectDir: string): string | null {
  const resolved = runGit(projectDir, ["rev-parse", "--git-path", "hooks/pre-push"]);
  return resolved.ok ? path.resolve(projectDir, resolved.stdout) : null;
}

function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

function isOurs(file: string): boolean {
  return readFileSync(file, "utf8").includes(HOOK_MARK);
}

/**
 * Writes git's pre-push hook, which runs `tmb pre-push`. Leaves a pre-push hook that is not
 * tmb's alone and says how to add the gate to it. Returns what it did, one line each.
 */
export function installPushGate(projectDir: string, tmbCommand: readonly string[]): string[] {
  const file = hookPath(projectDir);
  if (file === null) return ["Not a git work tree, so git's pre-push hook was not written; the push gate is off here."];
  const command = [...tmbCommand, "pre-push"].map(shellQuote).join(" ");
  if (existsSync(file) && !isOurs(file)) {
    return [`git's pre-push hook ${file} is not tmb's, so it was left alone; add this line to it to turn the push gate on: ${command} "$@"`];
  }
  const script = `#!/bin/sh\n${HOOK_MARK} tmb setup wrote this file and tmb remove deletes it.\nexec ${command} "$@"\n`;
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (before === script) return [`git's pre-push hook ${file} already runs the push gate.`];
  writeFileSync(file, script, { mode: 0o755 });
  return [`Wrote git's pre-push hook ${file}: every push from this project asks tmb first.`];
}

/** Deletes the pre-push hook setup wrote; a hook that is not tmb's stays. Returns what it did. */
export function removePushGate(projectDir: string): string[] {
  const file = hookPath(projectDir);
  if (file === null || !(statSync(file, { throwIfNoEntry: false })?.isFile() ?? false)) return [];
  if (!isOurs(file)) return [`git's pre-push hook ${file} is not tmb's, so it was left alone.`];
  rmSync(file);
  return [`Removed git's pre-push hook ${file}.`];
}
