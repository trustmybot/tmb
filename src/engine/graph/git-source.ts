// Reads a repo at one commit straight from git's objects, never from the working folder, so
// every session and worktree indexes the same content.
import { spawnSync } from "node:child_process";

const GIT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 1024 * 1024 * 1024;

/** One file of a commit's tree: its path, its blob and its size in bytes. */
export type TreeEntry = { path: string; blob: string; size: number };

function git(repoDir: string, args: string[], input?: Buffer): Buffer | null {
  const result = spawnSync("git", args, { cwd: repoDir, input, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

/** The commit a ref names, or null when it names none. */
export function resolveCommit(repoDir: string, ref: string): string | null {
  const out = git(repoDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = out?.toString("utf8").trim();
  return sha ? sha : null;
}

/** Whether `ancestor` is reachable from `descendant`. */
export function isAncestor(repoDir: string, ancestor: string, descendant: string): boolean {
  return git(repoDir, ["merge-base", "--is-ancestor", ancestor, descendant]) !== null;
}

/**
 * The newest commit of the base branch: the local branch or origin's copy of it, whichever
 * holds the other; the local branch when they have diverged. Null when neither exists.
 */
export function baseCommit(repoDir: string, baseBranch: string): string | null {
  const local = resolveCommit(repoDir, `refs/heads/${baseBranch}`);
  const remote = resolveCommit(repoDir, `refs/remotes/origin/${baseBranch}`);
  if (local === null || remote === null) return local ?? remote;
  if (local !== remote && isAncestor(repoDir, local, remote)) return remote;
  return local;
}

/** Every file of the commit's tree; submodules and links are left out. */
export function listTree(repoDir: string, commit: string): TreeEntry[] {
  const out = git(repoDir, ["ls-tree", "-r", "-l", "-z", commit]);
  if (out === null) throw new Error(`git could not list the tree of ${commit}`);
  const entries: TreeEntry[] = [];
  for (const record of out.toString("utf8").split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, type, blob, size] = record.slice(0, tab).split(/\s+/);
    if (type !== "blob" || mode === "120000" || blob === undefined) continue;
    entries.push({ path: record.slice(tab + 1), blob, size: Number(size) });
  }
  return entries;
}

/**
 * A reader of the commit's files by path, each read from git when first asked for: for the few
 * files known only once others are read.
 */
export function commitReader(repoDir: string, entries: readonly TreeEntry[]): (path: string) => string | undefined {
  const blobOf = new Map(entries.map((e) => [e.path, e.blob]));
  const read = new Map<string, string | undefined>();
  return (file) => {
    if (read.has(file)) return read.get(file);
    const blob = blobOf.get(file);
    const text = blob === undefined ? undefined : readBlobs(repoDir, [blob]).get(blob);
    read.set(file, text);
    return text;
  };
}

/** The text of each blob, read in one `git cat-file --batch`. */
export function readBlobs(repoDir: string, blobs: readonly string[]): Map<string, string> {
  const texts = new Map<string, string>();
  const wanted = [...new Set(blobs)];
  if (wanted.length === 0) return texts;
  const out = git(repoDir, ["cat-file", "--batch"], Buffer.from(`${wanted.join("\n")}\n`));
  if (out === null) throw new Error("git could not read the files' contents");
  let at = 0;
  while (at < out.length) {
    const lineEnd = out.indexOf(0x0a, at);
    if (lineEnd < 0) break;
    const [sha, type, size] = out.subarray(at, lineEnd).toString("utf8").split(" ");
    at = lineEnd + 1;
    if (type === "missing" || sha === undefined) continue;
    const length = Number(size);
    texts.set(sha, out.subarray(at, at + length).toString("utf8"));
    at += length + 1;
  }
  return texts;
}
