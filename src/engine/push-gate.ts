// The third layer of the gate: git's own pre-push hook asks the engine about every push, an
// agent's or one the Human types. In agile mode a commit reaches the base branch only inside a
// feature branch tip that the reviewer passed or the Human waived, so a push to the base branch
// is refused while it carries a commit no such tip holds, and the base branch is never deleted.
// Every other branch, the feature branches' backups among them, pushes freely: in agile mode
// review comes before the base branch, not before a backup. In truest mode review comes before
// a task's push too: a push to any branch is refused while it brings a task's commit that no
// reviewed or waived task commit holds. A commit of no task goes to a branch other than the
// base branch freely, so the Human's own branches need no waiver.
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Decision } from "./decide.ts";
import { runGit } from "./git.ts";
import { coveredCommits } from "./handlers/reviews.ts";
import { truestTaskCommits } from "./handlers/truest.ts";
import { runningName } from "./program.ts";
import { openProjectStore, projectDbPath } from "./project.ts";
import { TRUEST } from "./handlers/common.ts";
import { repoDirOf, repoOf } from "./repos.ts";
import { readSettings, type RepoPolicies, reviewModeOf } from "./settings.ts";
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
    `In agile mode work reaches the base branch through a feature branch: the reviewer passes it at its tip (or the Human runs \`${runningName()} feature waive <name> --reason <text>\`), then its pull request opens with feature_pr (\`${runningName()} feature pr <name> --title <text>\`).`,
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
    `In truest mode every task is reviewed before its push: the reviewer passes the task at its commit (or the Human runs \`${runningName()} task waive <id> --reason <text>\`), then tmb pushes it and opens its pull request with task_pr (\`${runningName()} task pr <id> --title <text>\`).`,
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
    if (opened.error.failure === "missing") {
      return { decision: "allow", reason: `${NO_RECORD} in ${projectDir}, so the push gate judged nothing; run \`${runningName()} init\` there, or \`${runningName()} remove\` to take the hook away` };
    }
    return denied(remote, `tmb cannot read the project's record, so it allows nothing: ${opened.error.message}`);
  }
  const store = opened.store;
  try {
    const refs = parsePushRefs(stdin);
    const settings = readSettings(store);
    const repo = repoOf(store, projectDir, pushDir);
    const base = repo?.baseBranch ?? null;
    // Each repo's push asks for what its own review mode requires (trustmybot/tmb#216).
    const truest = repo !== null && reviewModeOf(settings, repo.name) === TRUEST;
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

/** How a push the gate could not judge, for want of a record, begins: the hook says it, never passes in silence. */
export const NO_RECORD = "tmb found no project record";

/**
 * The command a hook runs: \`tmb pre-push --project <path>\`, the project's folder relative to the
 * repo's top. The hook carries it, so it never searches: git runs the hook at the repo's top, which
 * is not the project's folder when the project is one package of a monorepo (trustmybot/tmb#178).
 * A relative path names no machine's folder, so a hook file kept in the repo can carry it too.
 */
function gateCommand(tmbCommand: readonly string[], dir: string, projectDir: string): string {
  return [...tmbCommand, "pre-push", "--project", projectFromTop(dir, projectDir)].map(shellQuote).join(" ");
}

/**
 * The repo's main folder for \`dir\`: a linked worktree, a task's among them, belongs to the repo
 * its common git folder is in, so a relative project path names the same folder from either.
 */
export function repoTopOf(dir: string): string | null {
  const common = runGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.ok && path.basename(common.stdout) === ".git") return path.dirname(common.stdout);
  const top = runGit(dir, ["rev-parse", "--show-toplevel"]);
  return top.ok ? top.stdout : null;
}

/** The project's folder from the top of the repo \`dir\` is in, with forward slashes; "." at the top. */
function projectFromTop(dir: string, projectDir: string): string {
  const top = repoTopOf(dir);
  const relative = top === null ? "" : path.relative(real(top), real(projectDir));
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

/** The project folder a hook names, resolved from the top of the repo \`dir\` is in; null when it names none (one an older tmb wrote). */
export function hookProject(text: string, dir: string): string | null {
  const match = /'pre-push' '--project' '((?:[^']|'\\'')*)'/.exec(text);
  if (match === null) return null;
  const named = match[1]!.replace(/'\\''/g, "'");
  const top = repoTopOf(dir);
  return path.resolve(top ?? dir, named);
}

/**
 * The other tmb project whose push gate is already in the repo of \`dir\`: one repo holds one tmb
 * project for now, so init refuses a second one rather than turn the first one's gate off.
 */
export function otherProjectInRepo(dir: string, projectDir: string): string | null {
  const file = hookPath(dir);
  if (file === null || !existsSync(file) || !isOurs(file)) return null;
  const other = hookProject(readFileSync(file, "utf8"), dir);
  if (other === null || real(other) === real(projectDir)) return null;
  return existsSync(projectDbPath(other)) ? other : null;
}

function real(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

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
export function installPushGate(dir: string, tmbCommand: readonly string[], projectDir: string = dir): string[] {
  const file = hookPath(dir);
  if (file === null) return ["Not a git work tree, so git's pre-push hook was not written; the push gate is off here."];
  const command = gateCommand(tmbCommand, dir, projectDir);
  const other = otherProjectInRepo(dir, projectDir);
  if (other !== null) return [`git's pre-push hook ${file} is the push gate of the tmb project in ${other}, and one repo holds one tmb project for now, so it was left alone; the push gate is off for this project.`];
  if (existsSync(file) && !isOurs(file)) {
    return [foreignHookLine(dir, file)];
  }
  const script = `#!/bin/sh\n${HOOK_MARK} tmb init wrote this file and tmb remove deletes it.\nexec ${command} "$@"\n`;
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (before === script) return [`git's pre-push hook ${file} already runs the push gate.`];
  writeFileSync(file, script, { mode: 0o755 });
  return [`Wrote git's pre-push hook ${file}: every push from this project asks tmb first.`];
}

/** Deletes the pre-push hook init wrote; a hook that is not tmb's, or is another project's, stays. Returns what it did. */
export function removePushGate(dir: string, projectDir: string = dir): string[] {
  const file = hookPath(dir);
  if (file === null || !(statSync(file, { throwIfNoEntry: false })?.isFile() ?? false)) return [];
  if (!isOurs(file)) {
    const text = readFileSync(file, "utf8");
    if (!hasAddedLine(text)) return [`git's pre-push hook ${file} is not tmb's, so it was left alone.`];
    writeFileSync(file, text.split("\n").filter((line) => !line.includes(ADDED_MARK)).join("\n"));
    return [`Took tmb's line out of git's pre-push hook ${file}; the rest of it was left alone.`];
  }
  const owner = hookProject(readFileSync(file, "utf8"), dir);
  if (owner !== null && real(owner) !== real(projectDir)) return [`git's pre-push hook ${file} is the push gate of the tmb project in ${owner}, so it was left alone.`];
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
  return dirs.flatMap((dir) => installPushGate(dir, tmbCommand, projectDir));
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
  return gatedDirs(projectDir, repos, true).flatMap((dir) => removePushGate(dir, projectDir));
}

/**
 * What `tmb doctor` finds wrong with git's pre-push hooks: one line each, for every folder that
 * should run the push gate and does not run it with `tmbCommand`. Reads only.
 */
export function pushGateGaps(projectDir: string, repos: RepoPolicies | null, tmbCommand: readonly string[]): string[] {
  return gatedDirs(projectDir, repos, false).flatMap((dir) => {
    const command = gateCommand(tmbCommand, dir, projectDir);
    const file = hookPath(dir);
    if (file === null) return [];
    if (!existsSync(file)) return [`git's pre-push hook is missing in ${dir}: the push gate is off there`];
    const text = readFileSync(file, "utf8");
    if (!isOurs(file)) return runsAddedLineFirst(text) || text.includes(`${command} "$@"`) ? [] : [`${FOREIGN_GAP} ${file} is not tmb's and does not run the push gate`];
    return text.includes(`exec ${command} "$@"`) ? [] : [`git's pre-push hook ${file} runs another tmb than this one, or names another project folder than ${projectDir}`];
  });
}

// --- a pre-push hook that is not tmb's (trustmybot/tmb#184) -------------------------------

/**
 * The mark on the one line tmb adds to a pre-push hook that is not its own, such as husky's or
 * lefthook's, so \`tmb remove\` takes out that line alone. It does not hold HOOK_MARK: the hook
 * stays the other tool's.
 */
const ADDED_MARK = "# tmb: added for the push gate; tmb remove takes this line out.";

/** How a doctor gap on a hook that is not tmb's begins, so doctor can offer to add tmb's line. */
export const FOREIGN_GAP = "git's pre-push hook";

function hasAddedLine(text: string): boolean {
  return text.split("\n").some((line) => line.includes(ADDED_MARK));
}

/** The added line's hand-over of git's ref lines to the rest of the hook: a line without it is an older one (trustmybot/tmb#218). */
const HAND_OVER = 'exec < "$tmb_refs"';

/**
 * Whether the hook runs tmb's added line as it is now, before anything that could read git's ref
 * lines: only a shebang, blank lines and comments come before it.
 */
function runsAddedLineFirst(text: string): boolean {
  for (const line of text.split("\n")) {
    if (line.includes(ADDED_MARK)) return line.includes(HAND_OVER);
    if (line.trim() !== "" && !line.trim().startsWith("#")) return false;
  }
  return false;
}

/** What init and refresh say about a hook that is not tmb's: the gate is off there, and how to turn it on. */
function foreignHookLine(dir: string, file: string): string {
  return `The push gate is off in ${dir}: git's pre-push hook ${file} is not tmb's, so it was left alone. \`${runningName()} onboard --add-push-gate\` or \`${runningName()} doctor --fix\` adds tmb's one line to it, with your yes.`;
}

/**
 * The line tmb adds to a hook that is not its own, as its first line. It is safe to commit, as
 * husky's and lefthook's hook files often are: it calls the program by name and names the project
 * from the repo's top, no machine's path, and it does nothing where the program is not installed.
 * git gives the hook its ref lines once, on stdin, and runs it with none for a push that has
 * nothing to send, so tmb reads them first: it keeps them in a file, judges them, and hands the
 * same lines to the rest of the hook. It never ends the hook early unless the gate refuses the push.
 */
export function addedLine(program: string, dir: string, projectDir: string): string {
  const name = shellQuote(program);
  const run = [program, "pre-push", "--project", projectFromTop(dir, projectDir)].map(shellQuote).join(" ");
  // A step that fails before the gate has judged ends the push too; under `sh -e`, as husky runs hooks, nothing else ends it.
  return (
    `if command -v ${name} >/dev/null 2>&1; then tmb_refs=$(mktemp) || exit 1; ` +
    `cat > "$tmb_refs" && ${run} "$@" < "$tmb_refs" || { rm -f "$tmb_refs"; exit 1; }; ${HAND_OVER}; rm -f "$tmb_refs"; fi ${ADDED_MARK}`
  );
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);

/**
 * The program a hook names on its shebang line when it is not a shell, as a Node or Python hook
 * is; null for a shell script or one with no shebang, which git runs with sh.
 */
function nonShellProgram(text: string): string | null {
  const first = text.split("\n", 1)[0] ?? "";
  if (!first.startsWith("#!")) return null;
  const words = first.slice(2).trim().split(/\s+/);
  const named = path.basename(words[0] ?? "") === "env" ? words.slice(1).find((word) => !word.startsWith("-")) : words[0];
  const program = path.basename(named ?? "");
  return SHELLS.has(program) ? null : program;
}

/**
 * What tmb says about a hook in another language, which it does not change: how to call the gate
 * from it by hand, before anything in it reads git's ref lines.
 */
export function handCallLine(hook: ForeignHook, program: string, projectDir: string): string {
  const run = [program, "pre-push", "--project", projectFromTop(hook.dir, projectDir)].map(shellQuote).join(" ");
  return `The push gate stays off in ${hook.dir}: git's pre-push hook ${hook.file} is a ${hook.program} script, not a shell one, so tmb does not change it. To turn the gate on, have it run \`${run}\` with the hook's own arguments and git's ref lines on its input before it reads them, and end the push when that fails.`;
}

/** A repo whose pre-push hook is not tmb's and does not run the push gate: its folder and the hook file. */
export type ForeignHook = { dir: string; file: string; /** The hook's program when it is not a shell script, which tmb leaves alone; null for a shell script. */ program: string | null };

/** The repos, among those that should run the push gate, whose pre-push hook is another tool's and does not run it. */
export function foreignHooks(projectDir: string, repos: RepoPolicies | null): ForeignHook[] {
  return gatedDirs(projectDir, repos, false).flatMap((dir) => {
    const file = hookPath(dir);
    if (file === null || !existsSync(file) || isOurs(file)) return [];
    const text = readFileSync(file, "utf8");
    // An added line that is not first, or an older one, can miss git's ref lines: the gate is off until it is moved.
    return runsAddedLineFirst(text) ? [] : [{ dir, file, program: nonShellProgram(text) }];
  });
}

/**
 * Puts tmb's one line first in a hook that is not tmb's, after its shebang, after the Human's yes;
 * an older or misplaced added line is taken out first. Returns what it did.
 */
export function addToForeignHook(hook: ForeignHook, program: string, projectDir: string): string {
  const text = readFileSync(hook.file, "utf8");
  if (runsAddedLineFirst(text)) return `git's pre-push hook ${hook.file} already runs the push gate.`;
  if (hook.program !== null) return handCallLine(hook, program, projectDir);
  const lines = text.split("\n").filter((line) => !line.includes(ADDED_MARK));
  const at = lines[0]?.startsWith("#!") ? 1 : 0;
  lines.splice(at, 0, addedLine(program, hook.dir, projectDir));
  writeFileSync(hook.file, lines.join("\n") + (lines[lines.length - 1] === "" ? "" : "\n"));
  return `Added tmb's line first in git's pre-push hook ${hook.file}: every push from ${hook.dir} asks tmb first, the rest of the hook reads the same ref lines, and \`${runningName()} remove\` takes the line out.`;
}

/**
 * What a session start says while the push gate is off in a repo because its pre-push hook is
 * another tool's: every time, until the gate is on or the repo is exempt. Null when none is. Never throws.
 */
export function pushGateOffLine(projectDir: string): string | null {
  try {
    const opened = openProjectStore(projectDir, { create: false });
    if (!opened.ok) return null;
    let repos: RepoPolicies | null;
    try {
      repos = readSettings(opened.store).repos;
    } finally {
      opened.store.close();
    }
    const off = foreignHooks(projectDir, repos);
    if (off.length === 0) return null;
    const where = off.map((hook) => `${hook.dir} (its hook ${hook.file} is another tool's)`).join(", ");
    return `The push gate is off in ${where}: a push from there reaches the remote without tmb's review. \`${runningName()} onboard --add-push-gate\` or \`${runningName()} doctor --fix\` adds tmb's one line to the hook, with the Human's yes.`;
  } catch {
    return null;
  }
}
