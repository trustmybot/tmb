// The third layer of the gate: git's own pre-push hook asks the engine about every push, an
// agent's or one the Human types. In agile mode a commit reaches the base branch only inside a
// feature branch tip that the reviewer passed or the Human waived, so a push to the base branch
// is refused while it carries a commit no such tip holds, and the base branch is never deleted.
// Every other branch, the feature branches' backups among them, pushes freely: in agile mode
// review comes before the base branch, not before a backup. In truest mode review comes before
// a task's push too: a push to any branch is refused while it brings a task's commit that no
// reviewed or waived task commit holds. A commit of no task goes to a branch other than the
// base branch freely, so the Human's own branches need no waiver.
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Decision } from "./decide.ts";
import { runGit } from "./git.ts";
import { coveredCommits } from "./handlers/reviews.ts";
import { truestTaskCommits } from "./handlers/truest.ts";
import { openProjectStore } from "./project.ts";
import { TRUEST } from "./handlers/common.ts";
import { repoDirOf, repoOf } from "./repos.ts";
import { readSettings, type RepoPolicies } from "./settings.ts";
import type { Actor, Store } from "./store/index.ts";

/** One line git writes to the pre-push hook's stdin. */
export type PushRef = { localRef: string; localSha: string; remoteRef: string; remoteSha: string };

const ZERO_SHA = /^0+$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SHOWN_COMMITS = 10;

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
 * holds. Only what the remote says it holds, the sha git read from it, counts as already there:
 * a local ref, the remote-tracking one or the base a feature was cut from, can hold commits
 * that never reached the remote. Merge commits are left out: they bring no change of their own.
 */
function uncovered(store: Store, projectDir: string, ref: PushRef): { lines: string[]; shas: string[]; error: string | null } {
  const known = [
    ZERO_SHA.test(ref.remoteSha) ? null : commitOf(projectDir, ref.remoteSha),
    ...coveredCommits(store).map((commit) => commitOf(projectDir, commit)),
  ].filter((sha): sha is string => sha !== null);
  const listed = runGit(projectDir, ["rev-list", "--no-merges", "--format=%H %h %s", ref.localSha, "--not", ...new Set(known)]);
  if (!listed.ok) return { lines: [], shas: [], error: `git could not list the commits the push brings: ${listed.stderr || "no reason given"}` };
  const rows = listed.stdout.split("\n").filter((line) => line !== "" && !line.startsWith("commit "));
  const at = (row: string) => row.indexOf(" ");
  return { lines: rows.map((row) => row.slice(at(row) + 1)), shas: rows.map((row) => row.slice(0, at(row))), error: null };
}

function judgeRef(store: Store, projectDir: string, remote: string, base: string, ref: PushRef): string | null {
  if (ref.remoteRef !== `refs/heads/${base}`) return null;
  if (ZERO_SHA.test(ref.localSha)) return `it deletes the base branch ${base} on ${remote}, and tmb never lets the base branch go`;
  const found = uncovered(store, projectDir, ref);
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

/**
 * In truest mode the base branch is judged as in agile mode, and every other ref too: a task's
 * commit it brings must be held by a reviewed or waived task commit. A commit of no task passes.
 */
function judgeTruestRef(store: Store, projectDir: string, remote: string, base: string, ref: PushRef, repo: string | null): string | null {
  if (ZERO_SHA.test(ref.localSha)) {
    return ref.remoteRef === `refs/heads/${base}` ? `it deletes the base branch ${base} on ${remote}, and tmb never lets the base branch go` : null;
  }
  const toBase = ref.remoteRef === `refs/heads/${base}`;
  // Only what the remote reported holds counts as there: a local remote-tracking ref can be moved by hand.
  const found = uncovered(store, projectDir, ref);
  if (found.error !== null) return found.error;
  const taskCommits = toBase ? null : truestTaskCommits(store, projectDir, repo);
  const lines = taskCommits === null ? found.lines : found.lines.filter((_, index) => taskCommits.has(found.shas[index]!));
  if (lines.length === 0) return null;
  const shown = lines.slice(0, SHOWN_COMMITS).map((line) => `  ${line}`);
  if (lines.length > SHOWN_COMMITS) shown.push(`  and ${lines.length - SHOWN_COMMITS} more`);
  const what = toBase ? `onto the base branch ${base}` : `of a task to ${ref.remoteRef}`;
  return [
    `it brings ${lines.length} commit${lines.length === 1 ? "" : "s"} ${what} at ${short(ref.localSha)} that no task commit the reviewer passed, or the Human waived, holds:`,
    ...shown,
    "In truest mode every task is reviewed before its push: the reviewer passes the task at its commit (or the Human runs `tmb task waive <id> --reason <text>`), then tmb pushes it and opens its pull request with task_pr (`tmb task pr <id> --title <text>`).",
  ].join("\n");
}

function denied(remote: string, why: string): Decision {
  return { decision: "deny", reason: `tmb refused the push to ${remote}: ${why}` };
}

/**
 * Judges a push from git's pre-push hook: `remote` is the remote's name (or address) and `stdin`
 * the ref lines git passed. With no record it allows; a record it cannot read denies. With a
 * readable record the decision is recorded as a guard decision made by `pusher`: the agent a push
 * tmb ran names in its environment, or the Human, since git cannot say who typed a push. `pushDir`
 * is the folder git runs the hook in; in a workspace its repo's base branch is the one judged, and
 * a repo the record does not register, or registers as exempt, is not judged at all.
 */
export function judgePush(projectDir: string, remote: string, stdin: string, pushDir: string = projectDir, pusher: Actor = { kind: "human" }): Decision {
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) {
    if (opened.error.failure === "missing") return { decision: "allow" };
    return denied(remote, `tmb cannot read the project's record, so it allows nothing: ${opened.error.message}`);
  }
  const store = opened.store;
  try {
    const refs = parsePushRefs(stdin);
    const settings = readSettings(store);
    const repo = repoOf(store, projectDir, pushDir);
    const base = repo?.baseBranch ?? null;
    const truest = settings.review_mode === TRUEST;
    let decision: Decision;
    if (refs === null) decision = denied(remote, "git passed the hook a line that is not `<local-ref> <local-sha> <remote-ref> <remote-sha>`");
    else if (repo === null) decision = { decision: "allow", reason: "the push is from a repo this workspace does not register, or registers as exempt, so tmb has no policy for it" };
    else if (base === null) decision = { decision: "allow", reason: "no base branch is set, so no push is judged" };
    else {
      const judge = (ref: PushRef) => (truest ? judgeTruestRef(store, repo.dir, remote, base, ref, repo.name) : judgeRef(store, repo.dir, remote, base, ref));
      const why = refs.map(judge).find((reason) => reason !== null);
      const allowed = truest ? "no ref of the push brings an unreviewed task commit, or any unreviewed commit onto the base branch" : `no ref of the push brings unreviewed commits onto ${base}`;
      decision = why === undefined ? { decision: "allow", reason: allowed } : denied(remote, why);
    }
    store.appendGuardDecision(pusher, {
      event: JSON.stringify({ type: "before-push", raisedBy: "git", remote, ...(repo?.name ? { repo: repo.name } : {}), refs: refs ?? stdin }),
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
  const script = `#!/bin/sh\n${HOOK_MARK} tmb init wrote this file and tmb remove deletes it.\nexec ${command} "$@"\n`;
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (before === script) return [`git's pre-push hook ${file} already runs the push gate.`];
  writeFileSync(file, script, { mode: 0o755 });
  return [`Wrote git's pre-push hook ${file}: every push from this project asks tmb first.`];
}

/** Deletes the pre-push hook init wrote; a hook that is not tmb's stays. Returns what it did. */
export function removePushGate(projectDir: string): string[] {
  const file = hookPath(projectDir);
  if (file === null || !(statSync(file, { throwIfNoEntry: false })?.isFile() ?? false)) return [];
  if (!isOurs(file)) return [`git's pre-push hook ${file} is not tmb's, so it was left alone.`];
  rmSync(file);
  return [`Removed git's pre-push hook ${file}.`];
}

/** The folders that get the push gate: the project itself, or each workspace repo tmb works in. */
function gatedDirs(projectDir: string, repos: RepoPolicies | null, withExempt: boolean): string[] {
  if (repos === null) return [projectDir];
  return Object.keys(repos)
    // A folder that is no repo has no git to hook.
    .filter((name) => repos[name]!.git !== false && (withExempt || repos[name]!.exempt !== true))
    .map((name) => repoDirOf(projectDir, name));
}

/** Writes the pre-push hook into the project, or into each workspace repo that is not exempt. */
export function installPushGates(projectDir: string, repos: RepoPolicies | null, tmbCommand: readonly string[]): string[] {
  const dirs = gatedDirs(projectDir, repos, false);
  if (repos !== null && dirs.length === 0) return ["This workspace has no repo tmb works in, so no pre-push hook was written."];
  return dirs.flatMap((dir) => installPushGate(dir, tmbCommand));
}

/**
 * Deletes the pre-push hooks init wrote: the project's own, and in a workspace each registered
 * repo's, exempt ones too, in case one was gated before it was made exempt.
 */
export function removePushGates(projectDir: string): string[] {
  let repos: RepoPolicies | null = null;
  const opened = openProjectStore(projectDir, { create: false });
  if (opened.ok) {
    try {
      repos = readSettings(opened.store).repos;
    } finally {
      opened.store.close();
    }
  }
  return gatedDirs(projectDir, repos, true).flatMap((dir) => removePushGate(dir));
}

/**
 * What `tmb doctor` finds wrong with git's pre-push hooks: one line each, for every folder that
 * should run the push gate and does not run it with `tmbCommand`. Reads only.
 */
export function pushGateGaps(projectDir: string, repos: RepoPolicies | null, tmbCommand: readonly string[]): string[] {
  const command = [...tmbCommand, "pre-push"].map(shellQuote).join(" ");
  return gatedDirs(projectDir, repos, false).flatMap((dir) => {
    const file = hookPath(dir);
    if (file === null) return [];
    if (!existsSync(file)) return [`git's pre-push hook is missing in ${dir}: the push gate is off there`];
    const text = readFileSync(file, "utf8");
    if (!isOurs(file)) return text.includes(`${command} "$@"`) ? [] : [`git's pre-push hook ${file} is not tmb's and does not run the push gate`];
    return text.includes(`exec ${command} "$@"`) ? [] : [`git's pre-push hook ${file} runs another tmb than this one`];
  });
}
