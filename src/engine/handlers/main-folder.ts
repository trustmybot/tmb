// The main folder as a task found it. A worker works in its own worktree, and its host keeps its
// edits there, but a file copied or redirected by a shell command can still land in the main
// folder. tmb keeps the main folder's uncommitted changes as they were at the task's start, as a
// commit under its own ref, and at close names each file whose uncommitted state differs and how
// to put it back. A commit or a fold that moves the main folder's branch is not a change here:
// only what is left uncommitted is compared. It reports and never refuses (trustmybot/tmb#98).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGit } from "../git.ts";
import { PROJECT_DIR_NAME } from "../project.ts";

const SNAPSHOT_REF_PREFIX = "refs/tmb/main-folder/";

/** One file the main folder changed since the task started, and the command that puts it back. */
export type MainFolderChange = { path: string; change: "added" | "changed" | "deleted"; putBack: string };

/** What a close found in the main folder: the files changed since the task started, or why it could not tell. */
export type MainFolderReport = { changes: MainFolderChange[]; snapshot: string } | { unchecked: string };

function snapshotRef(taskId: string): string {
  return `${SNAPSHOT_REF_PREFIX}${taskId.toLowerCase()}`;
}

/** Every worktree inside the project other than the main folder, as paths relative to it, so a snapshot leaves them out. */
function worktreesInside(projectDir: string): string[] {
  const listed = runGit(projectDir, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) return [];
  const top = runGit(projectDir, ["rev-parse", "--show-toplevel"]).stdout;
  return listed.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.relative(top, line.slice("worktree ".length)))
    .filter((relative) => relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The tree of the main folder's files as they are now: tracked and untracked, but not ignored,
 * and without tmb's own folder or any worktree inside the project. Built in a throwaway index,
 * so the main folder's own index is never touched. Null when git cannot build it.
 */
function mainFolderTree(projectDir: string): string | null {
  const scratch = mkdtempSync(path.join(tmpdir(), "tmb-main-folder-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
    // An ignored folder is left out by git already, and naming it in a pathspec makes git add fail.
    const excluded = [PROJECT_DIR_NAME, ...worktreesInside(projectDir)]
      .filter((dir) => !runGit(projectDir, ["check-ignore", "--quiet", "--", dir]).ok)
      .map((dir) => `:(exclude,top)${dir.replace(/\\/g, "/")}`);
    if (!runGit(projectDir, ["add", "--all", "--", ":/", ...excluded], env).ok) return null;
    const tree = runGit(projectDir, ["write-tree"], env);
    return tree.ok ? tree.stdout : null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Keeps the main folder's files as they are now, for the task's close to compare with; returns the
 * commit, or null when git cannot keep them, which the close then reports as unchecked.
 */
export function snapshotMainFolder(projectDir: string, taskId: string): string | null {
  const tree = mainFolderTree(projectDir);
  if (tree === null) return null;
  // Its parent is the commit the main folder was at, so the snapshot's own diff is what was left uncommitted.
  const head = runGit(projectDir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const parent = head.ok ? ["-p", head.stdout] : [];
  const commit = runGit(projectDir, ["commit-tree", tree, ...parent, "-m", `tmb: the main folder at the start of task ${taskId}`], {
    GIT_AUTHOR_NAME: "tmb",
    GIT_AUTHOR_EMAIL: "tmb@localhost",
    GIT_COMMITTER_NAME: "tmb",
    GIT_COMMITTER_EMAIL: "tmb@localhost",
  });
  if (!commit.ok) return null;
  // A ref keeps the commit from git's garbage collection while the task is open.
  if (!runGit(projectDir, ["update-ref", snapshotRef(taskId), commit.stdout]).ok) return null;
  return commit.stdout;
}

/** Deletes the ref that kept the task's snapshot, once the task no longer needs it. */
export function dropMainFolderSnapshot(projectDir: string, taskId: string): void {
  runGit(projectDir, ["update-ref", "-d", snapshotRef(taskId)]);
}

function quoted(file: string): string {
  return /^[A-Za-z0-9._\/-]+$/.test(file) ? file : `'${file.replace(/'/g, `'\\''`)}'`;
}

/** The paths whose content in `to` differs from `from`, a commit or tree; `from` null for an empty tree. */
function changedPaths(projectDir: string, from: string | null, to: string): Set<string> | null {
  const diff = from === null ? runGit(projectDir, ["ls-tree", "-r", "--name-only", "-z", to]) : runGit(projectDir, ["diff", "--name-only", "--no-renames", "-z", from, to]);
  return diff.ok ? new Set(diff.stdout.split("\0").filter((file) => file !== "")) : null;
}

/** The object at `file` in `treeish`, or null when it holds no such file. */
function objectAt(projectDir: string, treeish: string, file: string): string | null {
  const found = runGit(projectDir, ["rev-parse", "--verify", "--quiet", `${treeish}:${file}`]);
  return found.ok ? found.stdout : null;
}

/**
 * Compares the main folder's uncommitted changes now with those at the task's start, and names
 * each file that differs: one changed since, or one whose change was put back or committed is
 * left out only when it is now as it was. Each comes with the command that puts it back.
 */
export function mainFolderReport(projectDir: string, snapshot: string | null): MainFolderReport {
  if (snapshot === null) return { unchecked: "the task kept no copy of the main folder at its start, so tmb could not compare it" };
  const now = mainFolderTree(projectDir);
  if (now === null) return { unchecked: "git could not read the main folder, so tmb could not compare it" };
  const startHead = runGit(projectDir, ["rev-parse", "--verify", "--quiet", `${snapshot}^`]);
  const head = runGit(projectDir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const dirtyAtStart = changedPaths(projectDir, startHead.ok ? startHead.stdout : null, snapshot);
  const dirtyNow = changedPaths(projectDir, head.ok ? head.stdout : null, now);
  if (dirtyAtStart === null || dirtyNow === null) return { unchecked: `git could not compare the main folder with its copy ${snapshot}` };
  const changes: MainFolderChange[] = [];
  for (const file of [...new Set([...dirtyAtStart, ...dirtyNow])].sort()) {
    const nowObject = objectAt(projectDir, now, file);
    // What the file should be: as the snapshot held it when it was changed at the start, else as the main folder's commit holds it.
    const source = dirtyAtStart.has(file) ? snapshot : head.ok ? head.stdout : null;
    const wanted = source === null ? null : objectAt(projectDir, source, file);
    if (nowObject === wanted) continue;
    const change = nowObject === null ? "deleted" : wanted === null ? "added" : "changed";
    const putBack = wanted === null ? `rm -- ${quoted(file)}` : `git restore --source=${source} --worktree -- ${quoted(file)}`;
    changes.push({ path: file, change, putBack });
  }
  return { changes, snapshot };
}

/** The close's lines about the main folder; none when nothing changed there. */
export function mainFolderNotes(report: MainFolderReport): string[] {
  if ("unchecked" in report) return [`The main folder was not checked: ${report.unchecked}.`];
  if (report.changes.length === 0) return [];
  return [
    `The main folder changed while the task was open. tmb cannot tell who changed it, so check each file; to put one back as it was at the task's start, run the command next to it in the main folder:`,
    ...report.changes.map((change) => `${change.change} ${change.path}: ${change.putBack}`),
  ];
}
