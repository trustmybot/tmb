// A worker starts inside its worktree. Its host makes the worktree, because a subagent cannot be
// started in a folder of tmb's choosing, and the host's hook for making one is not told which task
// the worker is for. So tmb adopts the host's worktree as the task's own once the worker names its
// task from there: the task's branch moves into the host's worktree, and the one tmb cut at the
// task's start is removed. The close cleans up the adopted worktree as its own, since the host
// keeps a worktree that holds changes (trustmybot/tmb#98).
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { repoOfRow } from "../repos.ts";
import { gitFailure, runGit } from "../git.ts";
import type { Actor, Store, Task } from "../store/index.ts";
import { OPEN } from "./common.ts";

/** What adoption did, as the decision's reason records it. */
export type Adoption = { adopted: boolean; reason: string };

function real(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function git(cwd: string, args: readonly string[]): string | null {
  const result = runGit(cwd, args);
  return result.ok ? result.stdout : null;
}

/** The repository's shared git folder, so two worktrees of one repository compare equal. */
function commonDir(dir: string): string | null {
  const found = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return found === null ? null : real(found);
}

/**
 * Adopts `folder`, where a worker named task `taskId` from, as the task's worktree, when the host
 * made it for the worker: another worktree of this repository, clean, with no commit of its own.
 * Anything else is left as it is and the reason says why; adoption never refuses the worker.
 */
export function adoptWorktree(store: Store, actor: Actor, recordDir: string, taskId: string, folder: string): Adoption {
  const keep = (reason: string): Adoption => ({ adopted: false, reason });
  const task = store.getTask(taskId);
  if (!task || task.state !== OPEN || task.branch === null || task.worktree === null) return keep(`task ${taskId} is not an open task with a worktree, so no worktree was adopted`);
  // The repository is the one the task was cut in: the project folder, or its repo in a workspace.
  const projectDir = repoOfRow(store, recordDir, task).dir;
  if (!existsSync(folder)) return keep(`the worker's folder ${folder} does not exist, so no worktree was adopted`);
  const top = git(folder, ["rev-parse", "--show-toplevel"]);
  if (top === null) return keep(`the worker's folder ${folder} is not in a git worktree, so no worktree was adopted`);
  const here = real(top);
  if (here === real(task.worktree)) return keep(`the worker works in task ${taskId}'s worktree`);
  if (here === real(git(projectDir, ["rev-parse", "--show-toplevel"]) ?? projectDir)) {
    return keep(`the worker started in the main folder, not in a worktree of its own, so no worktree was adopted`);
  }
  const common = commonDir(here);
  if (common === null || common !== commonDir(projectDir)) return keep(`${here} is not a worktree of this project, so it was not adopted`);
  const other = store.listTasks(OPEN).find((open) => open.id !== taskId && open.worktree !== null && real(open.worktree) === here);
  if (other) return keep(`${here} is task ${other.id}'s worktree, so it was not adopted for task ${taskId}`);
  if (git(here, ["status", "--porcelain"]) !== "") return keep(`${here} has changes that are not committed, so it was not adopted`);
  if (git(task.worktree, ["status", "--porcelain"]) !== "") {
    return keep(`task ${taskId}'s worktree ${task.worktree} has changes that are not committed, so ${here} was not adopted`);
  }
  // A host worktree with a commit of its own holds work that switching branches would leave behind.
  const hostHead = git(here, ["rev-parse", "HEAD"]);
  const taskTip = git(projectDir, ["rev-parse", `refs/heads/${task.branch}`]);
  if (hostHead === null || taskTip === null) return keep(`git could not read ${here} or the branch ${task.branch}, so no worktree was adopted`);
  const hostBranch = git(here, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  // Commits no branch but the host's own holds; --all would count every worktree's HEAD, the host's among them. A pattern for --branches names the branch without refs/heads/.
  const ownCommits = git(projectDir, ["rev-list", "--count", hostHead, "--not", ...(hostBranch === null ? [] : [`--exclude=${hostBranch}`]), "--branches", "--tags", "--remotes"]);
  if (ownCommits === null || (ownCommits !== "0" && hostHead !== taskTip)) return keep(`${here} holds commits of its own, so it was not adopted`);

  const removed = runGit(projectDir, ["worktree", "remove", task.worktree]);
  if (!removed.ok) return keep(`tmb could not remove task ${taskId}'s worktree ${task.worktree}, so ${here} was not adopted: ${gitFailure(removed)}`);
  const switched = runGit(here, ["switch", "--quiet", task.branch]);
  if (!switched.ok) {
    runGit(projectDir, ["worktree", "add", task.worktree, task.branch]);
    return keep(`git could not switch ${here} to the branch ${task.branch}, so it was not adopted and the task keeps ${task.worktree}: ${gitFailure(switched)}`);
  }
  store.updateTask(actor, taskId, { worktree: here });
  // The host's own branch now names nothing but the commit it was cut at; a branch with work of its own is kept.
  const dropped = hostBranch === null || hostBranch === task.branch || (ownCommits === "0" && runGit(projectDir, ["branch", "-D", "--", hostBranch]).ok);
  const branchNote = dropped ? "" : `; the host's branch ${hostBranch} was kept`;
  return { adopted: true, reason: `adopted ${here} as task ${taskId}'s worktree on its branch ${task.branch}, in place of ${task.worktree}${branchNote}` };
}

/**
 * The other worktrees of this repository whose commits build on task `task`'s base commit and go
 * past it: where a worker's work sits when it committed in its host's folder before it named its
 * task, so tmb never adopted that folder. Leaves out the main folder and every open task's worktree.
 */
export function workElsewhere(store: Store, task: Task): string[] {
  if (task.worktree === null || task.baseCommit === null) return [];
  const listed = git(task.worktree, ["worktree", "list", "--porcelain"]);
  if (listed === null) return [];
  const folders = listed.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
  const taken = new Set(store.listTasks(OPEN).flatMap((open) => (open.worktree === null ? [] : [real(open.worktree)])));
  const main = folders[0] === undefined ? null : real(folders[0]);
  return folders.filter((folder) => {
    const here = real(folder);
    if (here === main || taken.has(here) || !existsSync(folder)) return false;
    const head = git(folder, ["rev-parse", "HEAD"]);
    return head !== null && head !== task.baseCommit && runGit(folder, ["merge-base", "--is-ancestor", task.baseCommit!, head]).ok;
  });
}
