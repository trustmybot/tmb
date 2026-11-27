# When a step fails

A failure goes back to its owner. tmb waits for no timer: it acts only when something calls it.

| What failed | What you do |
|---|---|
| `task_close` refused on a check or on uncommitted work | The refusal names the cause. The task stays open: its worker fixes it and closes again. For a docs task, you do. |
| `task_close` refused on a file that is not a docs type, in a docs task | That part is code: drop it from the docs task and give it to a worker in a code task. |
| `task_close` refused on a conflict with the feature branch | The rebase is undone, and the refusal names the files and how to settle them. The task stays open: its worker settles it in the worktree and closes again. |
| `feature_update` conflicts | Nothing changed, and the answer names the files. Settle it in a task on the branch whose worker merges the base in its worktree, or raise it to the Human, then call `feature_update` again. |
| The reviewer fails the feature branch | Start a task for each blocking finding on the branch, and review again once they land. |
| A check or a review comment fails an open pull request | Start fix tasks on its feature branch; `feature_pr` updates the same pull request once the new tip is reviewed or waived. |
| A run started and never ended | The session start or `tmb doctor` names it. Resume the task with a new worker, or drop it. |

## Drop a task

When a task's approach is wrong, or nobody will finish it, end it with `task_drop` and the reason instead of leaving it open: an open task holds back tmb's updates. Its worktree goes unless it holds uncommitted work, and its branch stays while it holds commits. When new work takes its place, name the dropped task in `task_start`'s `replaces`.

## Drop a feature branch

When nobody will merge a feature branch, or its work reached the base branch in a way tmb does not see, end it with `feature_drop` and the reason, saying where the work went. A branch whose pull request is open is refused: the Human closes the pull request first. Its branch stays in git.
