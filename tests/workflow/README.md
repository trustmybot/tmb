# Workflow simulation tests

A whole flow as a scripted sequence of tool calls through the tool server, with no model. They run with `bun test` on every pull request ([all layers](../README.md)).

## Tasks

| Test | What it proves |
|---|---|
| [task-close.test.ts](task-close.test.ts) | The project's check fails until the fix lands, so the close waits for it, and a closed task never closes twice. |
| [flow-02-simple-task.test.ts](flow-02-simple-task.test.ts) | The planner records the issue, starts a feature branch and a task, a worker commits the work and closes it, and the close folds it into the feature branch. The worker is refused the planner's steps. |
| [flow-03-difficult-task.test.ts](flow-03-difficult-task.test.ts) | A difficult task, with a question and its answer recorded as notes. |
| [flow-09-cold-restart.test.ts](flow-09-cold-restart.test.ts) | A new session's start lists the open issue and the open task from the record, and asks for no init or onboarding; the settings onboard stored are still in force. |
| [flow-11-concurrent-siblings.test.ts](flow-11-concurrent-siblings.test.ts) | Two open tasks on one feature branch, each in its own worktree: closing the first folds it and leaves the second open; closing the second rebases it onto the moved feature branch, runs the checks again and folds it. |
| [shared-files.test.ts](shared-files.test.ts) | Two open tasks may share a file: changes to different lines fold, and the later close on the same lines stops. |
| [flow-13-issue-update.test.ts](flow-13-issue-update.test.ts) | The planner moves an issue to another milestone and rewrites its title and body; history shows each change with who made it. An update naming no field is refused, and one that changes nothing records nothing. |
| [docs-task-check.test.ts](docs-task-check.test.ts) | A docs task whose change touches a source file cannot close, and the refusal names the file; once its change touches only docs, markup and data it closes; a code task is never checked this way. |
| [close-checks.test.ts](close-checks.test.ts) | A commit outside the task's files closes, and the close names those files and leaves the spec as written; a file added, changed or deleted in the main folder during the task is named at close with a command that puts it back, and one left there before the task is not; the host's worktree is adopted as the task's on the worker's first call and removed at close, and a worker in the main folder or the task's own worktree changes nothing. |

## Feature branches and review

| Test | What it proves |
|---|---|
| [feature-fold.test.ts](feature-fold.test.ts) | A code task and then a docs task fold into one feature branch in order. |
| [review-gate.test.ts](review-gate.test.ts) | Review, fail, rework, pass and the pull request on one feature branch, and a Human waiver on a second; only a reviewer run records a verdict, and only on the branch's tip. tmb keeps no retry count, so escalation is the planner's call, not a rule. |
| [review-mark.test.ts](review-mark.test.ts) | The mark on GitHub belongs to one commit: a commit the reviewer passed is marked, and a new commit after it has no mark until it is reviewed and on GitHub. |
| [feature-after-pr.test.ts](feature-after-pr.test.ts) | A feature branch after its pull request: while it is open the branch takes fix tasks, a fold does not push the unreviewed tip, and `feature_pr` pushes the reviewed tip to the same pull request, a task open before the pull request opened included; closed without a merge, it takes a new pull request or a rework task that reopens it; a pull request already open from the branch is recorded, not opened twice; merged, it takes neither. |
| [truest.test.ts](truest.test.ts) | A task cannot be pushed unreviewed: task_pr and a push typed by hand through git's pre-push hook are refused. Review, fail, rework and pass on one task, then task_pr rebases onto a base branch that moved, carries the review over the unchanged patch, pushes the task branch and opens its pull request. A rebase that changes the patch needs a new review, a conflict reopens the task, and a Human waiver lets a task through. |
| [no-remote.test.ts](no-remote.test.ts) | In a project with no remote nothing is pushed and no pull request opens: once the reviewer passes, tmb records the work ready and tells the Human the merge command, then records it merged once the base branch holds its tip. |
