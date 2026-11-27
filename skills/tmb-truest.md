# Truest mode: a review and a pull request per task

In a project, or a repo of a workspace, whose review mode is `truest`, every task gets its own review and its own pull request. There are no feature branches in it: `feature_start` is refused, and `task_start` cuts the task's branch from the base branch.

> spec → `task_start` → a worker implements it → `task_close` runs the checks → the task is in review → the reviewer reviews its commit → a fail reopens it for rework, a pass covers it → `task_pr` → the Human merges

- Once `task_close` passes, the task waits in review at its commit; nothing is folded or pushed. Start the reviewer with the brief's `review_task=<id>` line at the head of its prompt. It records its verdict with `task_review`.
- On a fail, the task reopens in the same worktree: start a worker on it again with the blocking findings, then close it again for a new review.
- Once a pass, or a waiver the Human recorded with `tmb task waive`, covers the task's commit, open its pull request with `task_pr` yourself, without waiting to be asked. When the base branch moved, tmb rebases the task first and runs its checks again: an unchanged patch keeps its review, a changed one needs a new review, and a conflict reopens the task.
- git's pre-push hook refuses any push that brings a task's commit no review or waiver covers, and any push onto the base branch of a commit none covers.
