# Workflow simulation tests

A whole flow as a scripted sequence of tool calls through the tool server, with no model. They run with `bun test` on every pull request ([all layers](../README.md)).

## Flows

**Each built flow in [docs/flows/FLOWS.md](../../docs/flows/FLOWS.md) has one scenario test of its ideal case here, named `flow-<number>-<name>.test.ts`.** A change that breaks a flow's ideal case fails that flow's test. A Planned flow has none until it is built.

- **Example.** Flow 3.10, Truest mode, is [flow-3.10-truest-mode.test.ts](flow-3.10-truest-mode.test.ts).
- **Edge case.** A step the layer cannot run is left to the layer that can: flow 1.1's one-step install is the [Install](../install/README.md) layer's.

| Flow | Test | What it proves |
|---|---|---|
| 1.1 Install and session start | [flow-1.1-install-and-session-start.test.ts](flow-1.1-install-and-session-start.test.ts) | `tmb init` on a fresh project asks no question, writes the record, the host's files and git's pre-push hook, indexes the code graph, and ends with the numbered next steps, a line saying the settings are empty and how they get filled, and a line saying the review mode is the Human's, plain when piped; the next session start gives the planner its role and says the settings are empty. |
| 1.2 Updates and channels | [flow-1.2-updates-and-channels.test.ts](flow-1.2-updates-and-channels.test.ts) | For each of dev, rc and stable against a local release repo: the build is kept at a session's start and swapped in at a session's end, an open task holding the update back until it closes; plus `tmb update --check`, an update with no session, no network, a checksum mismatch, `TMB_NO_UPDATE=1`, and a dev build whose count restarted. A program's name says what it follows and where it keeps its state: `tmb`, `tmb-rc`, `tmb-dev` and a pinned `tmb-<version>` installed in one home each report their own channel and update only themselves; the pinned one never does. A project initialised with `tmb-dev` has its tool server, hooks and push hook call `tmb-dev`, until `tmb init` moves it. |
| 2.1 First contact | [flow-2.1-first-contact.test.ts](flow-2.1-first-contact.test.ts) | The first session start tells the planner the settings are empty and what tmb recommends, settings_set through the tool server fills them, and the section is gone after; with no review mode, an unattended tool server refuses task_start and the planner's choice of mode, and the Human's `tmb onboard --review-mode --yes` lets the task start. |
| 2.2 Index and code-graph refresh | [flow-2.2-code-graph-refresh.test.ts](flow-2.2-code-graph-refresh.test.ts) | Through `tmb index`, `tmb graph`, the session start and the tool server, the graph is current after a change lands on the base branch, with no index run. |
| 3.1 Task | [flow-3.1-task.test.ts](flow-3.1-task.test.ts) | The planner records the issue, starts a feature branch and a task, a worker commits the work and closes it, and the close folds it into the feature branch. The worker is refused the planner's steps. |
| 3.9 Agile mode | [flow-3.9-agile-mode.test.ts](flow-3.9-agile-mode.test.ts) | Review, fail, rework, pass and the pull request on one feature branch, and a Human waiver on a second; only a reviewer run records a verdict, and only on the branch's tip. tmb keeps no retry count, so escalation is the planner's call, not a rule. |
| 3.10 Truest mode | [flow-3.10-truest-mode.test.ts](flow-3.10-truest-mode.test.ts) | A task cannot be pushed unreviewed: task_pr and a push typed by hand through git's pre-push hook are refused. Review, fail, rework and pass on one task, then task_pr rebases onto a base branch that moved, carries the review over the unchanged patch, pushes the task branch and opens its pull request. A rebase that changes the patch needs a new review, a conflict reopens the task, and a Human waiver lets a task through. |
| 5.1 Bug report | [flow-5.1-bug-report.test.ts](flow-5.1-bug-report.test.ts) | Through the tool server, the planner drafts a report cleaned of the project's path; a send with no yes is refused and `gh` files nothing; on the Human's yes a fake `gh` files it, and a second send is refused as already filed. |

## Tasks

| Test | What it proves |
|---|---|
| [task-close.test.ts](task-close.test.ts) | The project's check fails until the fix lands, so the close waits for it, and a closed task never closes twice. |
| [difficult-task.test.ts](difficult-task.test.ts) | A difficult task, with a question and its answer recorded as notes. |
| [cold-restart.test.ts](cold-restart.test.ts) | A new session's start lists the open issue and the open task from the record, and asks for no init or onboarding; the settings onboard stored are still in force. |
| [concurrent-siblings.test.ts](concurrent-siblings.test.ts) | Two open tasks on one feature branch, each in its own worktree: closing the first folds it and leaves the second open; closing the second rebases it onto the moved feature branch, runs the checks again and folds it. |
| [shared-files.test.ts](shared-files.test.ts) | Two open tasks may share a file: changes to different lines fold, and the later close on the same lines stops. |
| [issue-update.test.ts](issue-update.test.ts) | The planner moves an issue to another milestone and rewrites its title and body; history shows each change with who made it. An update naming no field is refused, and one that changes nothing records nothing. |
| [docs-task-check.test.ts](docs-task-check.test.ts) | A docs task whose change touches a source file cannot close, and the refusal names the file; once its change touches only docs, markup and data it closes; a code task is never checked this way. |
| [close-checks.test.ts](close-checks.test.ts) | A commit outside the task's files closes, and the close names those files and leaves the spec as written; a file added, changed or deleted in the main folder during the task is named at close with a command that puts it back, and one left there before the task is not; the host's worktree is adopted as the task's on the worker's first call and removed at close, and a worker in the main folder or the task's own worktree changes nothing. |

## Feature branches and review

| Test | What it proves |
|---|---|
| [feature-fold.test.ts](feature-fold.test.ts) | A code task and then a docs task fold into one feature branch in order. |
| [review-mark.test.ts](review-mark.test.ts) | The mark on GitHub belongs to one commit: a commit the reviewer passed is marked, and a new commit after it has no mark until it is reviewed and on GitHub. |
| [feature-after-pr.test.ts](feature-after-pr.test.ts) | A feature branch after its pull request: while it is open the branch takes fix tasks, a fold does not push the unreviewed tip, and `feature_pr` pushes the reviewed tip to the same pull request, a task open before the pull request opened included; closed without a merge, it takes a new pull request or a rework task that reopens it; a pull request already open from the branch is recorded, not opened twice; merged, it takes neither. |
| [no-remote.test.ts](no-remote.test.ts) | In a project with no remote nothing is pushed and no pull request opens: once the reviewer passes, tmb records the work ready and tells the Human the merge command, then records it merged once the base branch holds its tip. |
