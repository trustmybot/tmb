# Agent task handling

Every case of flows 3.1 to 3.5 in [FLOWS.md](FLOWS.md): a task from the Human's ask to its close, its failure paths, its states and how to debug a stuck one. The review and the pull request are in [3_WORKFLOW.md](3_WORKFLOW.md). Branches, worktrees and the push gate are in [3_GIT.md](3_GIT.md).

```mermaid
flowchart LR
    A["Human asks"] --> B["Planner: issue and spec"]
    B --> C["Engine starts the task"]
    C --> D["Author works, unwatched"]
    D --> E["Checkpoint: checks at close"]
    E --> F["Checkpoint: the review"]
    F --> G["Checkpoint: the push gate"]
    G --> H["Human merges"]
    E -. fails .-> X["3.4: back to its owner"]
    F -. fails .-> X
    G -. fails .-> X
```

tmb checks the outcome at these three checkpoints and watches no step in between ([PRINCIPLES.md](../architecture/PRINCIPLES.md), [ENGINE.md](../architecture/ENGINE.md#containment)). What each step leaves in the record is in [TRAJECTORY.md](../architecture/TRAJECTORY.md).

## Units of work

A task is one change that one agent can finish in one run.

| Unit | What it is |
|---|---|
| **Issue** | One goal of the Human's, with the notes and decisions that shaped it |
| **Task** | One change, with a spec: the intent, the files it may touch, the checks that must pass and the success criteria |
| **Milestone** | A group of issues the Human wants to judge as a whole, such as a first usable build |

- **Two kinds of task.** A **code task**, which a worker implements ([3.1](#31-code-task)), and a **docs task**, a docs or prompts change the planner writes itself ([3.2](#32-non-code-task)). Both end in the same review, push gate and retry paths.
- **The review mode decides where a task's review happens,** and a task keeps the mode it was started in ([3_WORKFLOW.md](3_WORKFLOW.md)).

## Quality layers

Each step owns one level of quality and hands the next a ready state. No step redoes another step's check ([PRINCIPLES.md](../architecture/PRINCIPLES.md), [ROLES.md](../architecture/ROLES.md)). A step's method is deterministic, done by the engine, or judgment, made by a role.

```mermaid
flowchart LR
    H["Human: intent"] --> P["Planner: spec and design fit"]
    P --> W["Author: functionality<br/>checkpoint: checks at close"]
    W --> R["Reviewer: the diff<br/>checkpoint: the review"]
    R --> G["git: every push<br/>checkpoint: the push gate"]
    G --> CI["CI confirms, it does not discover"]
```

- **Failures return to their owner.** A failed check goes back to the author, a review finding to the author, a design misfit to the planner's spec.
- **Leaks point upstream.** When a later step or CI catches a cheap check, the fix is to move that check into the step that owns it. A leak rate per step as the health metric is Planned.

## 3.1 Code task

Any change that touches code. The planner plans and judges, a worker implements, the reviewer reviews and the Human merges. The engine does every git step ([ENGINE.md](../architecture/ENGINE.md#containment)).

| Step | Owner | Method | What it guarantees and hands over |
|---|---|---|---|
| Ask | Human | judgment | Intent. When it is vague, the Human and the planner pin it down |
| Record the goal | planner | judgment | An issue titled in the Human's words, saved before any planning, with open questions as a note |
| Spec | planner | judgment | Scoped from the code graph, not by reading files: what to change and why, the files, the checks, and success criteria a check can prove. The planner names the task's kind. Planned (trustmybot/tmb#301): the spec names the flow or design page it implements, and design fit is judged against that page |
| Start the task | engine | deterministic | The task's branch and worktree ([3_GIT.md](3_GIT.md#starting-a-task)) and its brief. Refused until the review mode is set. The engine names the open tasks that share a file, as information |
| Start the worker | host, checked by the gate | deterministic | A worker starts only on an open task whose worktree is ready. The start is recorded as a run |
| Implement | worker | judgment | The spec exactly, in the task's worktree. No edit or command is checked on the way |
| Close | engine | deterministic | The task's and the repo's checks pass on the committed work, or the close is refused and names what failed |
| Fold, review, design fit, pull request, merge | by review mode | | [3_WORKFLOW.md](3_WORKFLOW.md) |

- **A close refuses only on its checks, its commit and a clash.** The causes: a failing check, uncommitted work, no commit past where the task was cut, a docs task's file that is not a docs type, or a conflict at the fold ([3_WORKFLOW.md](3_WORKFLOW.md#safe-close)).
  - **Edge case.** A refused close changes nothing. The task stays open, and the feature branch and the worktree stay as they were.
- **A task with no checks never closes.**
- **Checks never fail open.** A check that could not run is recorded as not run, with the reason, and the task stays open.
- **A close reports two things without refusing.**
  - **Example 1.** The commit changes a file the spec does not list. The close names the file and the spec stays as written. The planner or the reviewer checks those names with git.
  - **Example 2.** A file in the main folder changed since the task started. The close lists each one with the command that puts it back, and the planner raises the list to the Human. tmb puts nothing back, because the change may be the Human's own.
- **Two tasks may change the same file.** There is no lock. git settles it at the fold, and a clash holds back the later task's close.
- **The planner closes the issue.** Planned: it closes itself once all its tasks' commits reach the base branch.
- **Planned at close:** a changelog check, a stale-doc check and a leak check, a probe for each open finding, and a code graph check that no downstream caller breaks.

## 3.2 Non-code task

tmb calls it a **docs task**: a change to docs or prompts that changes no behaviour. It runs 3.1's steps with the planner in the worker's place. These steps differ:

| Step | Owner | What differs |
|---|---|---|
| Name the kind | planner | The planner judges whether a change is docs. A project declares no list of docs paths: such a list is wrong for the next project and the next file |
| Author | planner | The planner writes in the task's worktree. No edit is refused on the way |
| Close | engine | 3.1's checks, plus a check by file type: only prose, data and image types on a fixed list, and files with no extension such as a licence, may change. A type the list does not name counts as code. tmb does not read the file to guess. The list is in the [reference](../reference/README.md#what-a-docs-task-may-change) |
| Review | reviewer | Seen in the same review as the code tasks. The engine cannot tell whether a config or data change alters behaviour; a docs task that did is a blocking finding |

| What goes wrong | What happens |
|---|---|
| The commit touches a file that is not a docs type | The close is refused and names the file. The code part becomes a code task for a worker |
| A check fails at close | The task stays open: the planner fixes and closes again |
| The reviewer finds the docs task changed behaviour | A blocking finding: that part is redone as a code task |
| Fold conflict, rebase conflict, or a failing check after rebase | As for a code task ([3.4](#34-retry-and-escalation)) |

- **Planned: the doc-review skill.** The author's self-check and the reviewer's matching checklist.

## 3.3 Push gate

After the close, a task of either kind passes two more checkpoints. Each has its own page.

| Checkpoint | Rule | Every case |
|---|---|---|
| The review | The reviewer records a verdict on one exact commit: the feature branch's tip in agile mode, the task's commit in truest | [3_WORKFLOW.md](3_WORKFLOW.md) |
| The pull request | The engine opens it only when a pass or a Human waiver covers that commit | [3_WORKFLOW.md](3_WORKFLOW.md#merge-gate) |
| The push gate | git's pre-push hook refuses a push that carries a commit no pass or waiver covers | [3_GIT.md](3_GIT.md#the-push-gate-at-gits-own-hook) |

## 3.4 Retry and escalation

Every failure and its path, in the order a task meets them. Nothing here waits for a timer: tmb runs only when something calls it.

| Cause | Path |
|---|---|
| A worker start names no open task | The start is denied, with what would be allowed; the guard decision is recorded |
| The host fails to make the worker | The run ends as stopped, in the record |
| Worker runs out of turns | **Planned:** it commits a checkpoint and hands back; the next run resumes |
| Broken environment or contradictory spec | The worker stops and reports. **Planned:** the task is marked failed and the planner reopens it |
| A check fails at close | The close is refused and names the check, and the failing check run is recorded. The task stays open; the worker fixes and closes again |
| Uncommitted work at close | The close is refused and names the files; then as for a failed check |
| Fold or rebase conflict | The step is undone and names the files; the task stays open until settled |
| Review fail, truest | The review is recorded with its blocking findings and the task reopens in the same worktree. A worker reworks it and closes again for a new review |
| Review fail, feature branch | The planner starts a fix task per blocking finding on the branch; the new tip is reviewed again |
| Two review fails in a row | **Planned** (trustmybot/tmb#400): no worker starts on the task until the planner records the root cause |
| Base branch moved under a feature branch | The engine merges it in before the review; a conflict changes nothing and is settled in a task |
| Checks fail after a truest rebase | The rebase is undone and the task is open again; the worker fixes and closes again |
| Rebased truest commit whose change differs | The task stays in review: one new review of the rebased commit |
| A push carries a commit no pass or waiver covers | git refuses the push; the guard decision is recorded |
| A check or a comment fails an open pull request | The planner starts fix tasks on the branch; nothing is pushed until the new tip is reviewed or waived. **Planned:** bringing the comments in ([3.5](#35-pr-comment-triage)) |
| Pull request closed without a merge | The branch is recorded as closed and named at session start; a new pull request or a rework task reopens it |
| Work merged outside the flow | The push gate refuses the uncovered push. **Planned:** its open tasks close, each recorded as a bypass when no review passed |
| Design drift | The planner drops the task and replaces it. **Planned:** the planner amends the spec and reopens |
| Wrong approach, or nobody will finish | The planner or the Human drops the task with a reason; a new task names the one it replaces |
| Nobody will merge the feature branch | The branch is dropped with a reason and kept in git |
| A run started and never ended | Named at the next session start and by the health check; the planner decides |

- **Rework is bounded** (Planned). The number of runs alone never blocks a run; two fails since the last pass do, until the cause is recorded.
- **Nothing waits on the Human** except what only the Human may do: a waiver, the review mode, the merge.

## 3.5 PR comment triage

Planned (trustmybot/tmb#70).

```mermaid
flowchart TD
    A["Trigger: sync with the remote, or the Human points at the pull request"] --> B["Each comment stored once on the linked issue"]
    B --> C{"Would it change the issue's intent or scope?"}
    C -- yes --> D["Recorded on the issue: the planner asks the Human"]
    C -- no --> E["Grouped into fix tasks through 3.1 or 3.2, on the same branch"]
    E --> F["New tip reviewed or waived, then the same pull request is updated"]
```

- **Stored once.** A per-pull-request cursor means a re-fetch returns only newer comments.
- **Intent stays the Human's.**
- **Unresolvable pull requests are skipped,** and the gap is recorded.

## Task lifecycle

Every task of both kinds moves through one state machine. Each move is added to the record as an event, the current state is derived from the events, and the engine is the only writer.

```mermaid
stateDiagram-v2
    [*] --> open: the planner starts the task
    open --> closed: agile, checks pass and the task folds
    open --> in_review: truest, checks pass
    in_review --> open: review fails, or the rebase conflicts or fails its checks
    in_review --> closed: pass or waiver, pull request opened
    in_review --> closed: the base branch already holds the change
    in_review --> ready: pass or waiver, repo has no remote
    ready --> closed: the local base branch holds the work
    open --> dropped: dropped with a reason
    in_review --> dropped: dropped with a reason
    ready --> dropped: dropped with a reason
    closed --> [*]
    dropped --> [*]
```

| State | Means |
|---|---|
| open | Work may be done on it. The task's runs say whether an agent is on it. A stuck task stays open until the planner resumes or drops it |
| in_review | A truest task whose checks passed, waiting at its commit. The newest review of the commit says where it stands |
| ready | Covered by a pass or a waiver in a repo with no remote, waiting for the Human's local merge |
| closed | Final. An agile task is folded, with its mode recorded; the review or waiver is on the feature branch. A truest task has its pull request |
| dropped | Final, with a reason. The task that replaces it names it |
| failed | **Planned.** A task whose worker stopped on a broken environment or a contradictory spec ([3.4](#34-retry-and-escalation)) |

- **Closed and dropped are final.** Rework on closed agile work is a new fix task on the feature branch. A dropped task's work reaches no branch. A new task can name the dropped task it replaces, so a chain of retries reads as one line.
- **In review keeps its worktree.** Nothing is pushed. Only a reviewer run records the verdict, and only on the task's current commit.
- **Ready is for a repo with no remote.** The Human merges locally with the command tmb gives, and tmb then counts the work as merged ([3_WORKFLOW.md](3_WORKFLOW.md#a-project-with-no-remote)). A ready task the Human will not merge is dropped.
- **Dropping keeps what holds work** ([3_GIT.md](3_GIT.md#closing-a-task)).
- **An agile task closes unreviewed.** Its review state is on the feature branch, not the task ([3_WORKFLOW.md](3_WORKFLOW.md#review-state)).
- **Review is the default, and only the Human waives it.** A waiver is given per truest task or per feature branch, with a reason, on a terminal with a typed yes. It counts as a pass on the current commit and is kept in the record as a waiver. The planner never waives.
- **Auditing is a join.** A task's story is its events in order, joined with its runs, check runs and reviews.
- **Planned:** each move names a cause from a fixed list and the record it rests on, and the record refuses a move without it.
- **Planned:** a move the planner takes by hand carries a note saying why, so no bypass is silent.
- **Planned:** closing an issue ends its open tasks.
- **Planned: freeze** (trustmybot/tmb#64). The Human stops all work in a project with one request: task and agent starts, closes and pull requests are denied until it is lifted. Reads stay allowed.
- **Open, for the Human:** waivers wider than one task or one branch (a listed set, an issue, a session's docs tasks).

## Debugging a stuck task

tmb has no watcher, so a stuck task is found at the next session start or by `tmb doctor` ([TRAJECTORY.md](../architecture/TRAJECTORY.md)).

| Symptom | Where to look |
|---|---|
| No task will start | The review mode is not set: the Human runs `tmb onboard`. Or the issue is closed |
| The worker will not start | Its start prompt must carry the task's id line from the brief, and the task must be open with its worktree present. In a multi-repo workspace, start it from inside the task's repo; the deny names the folder |
| The task will not close | The refusal names it: a failing check, uncommitted work, a conflict with the feature branch, no checks set, or, for a docs task, a file that is not a docs type |
| The reviewer's verdict is refused | No reviewer run is open, the commit is not the branch's current tip, or the task is not in review at that commit |
| The pull request will not open | No pass or waiver covers the tip or the commit. The Human waives with `tmb feature waive` or `tmb task waive` |
| The push is denied | It carries a commit no pass or waiver covers, or the record cannot be read. The hook's message names the cause |
| The push gate is off | Another tool owns the pre-push hook: `tmb doctor --fix` or `tmb onboard --add-push-gate` |
| A task is open and nothing works on it | `tmb doctor` lists runs with no end and open tasks with no run. The planner resumes it or drops it |
| A branch stays ready after a local merge | The base branch changed the same lines again; drop it with a reason that says where the work went |
| Every command stops | The record is unreadable or from a newer tmb. `tmb doctor` still runs and names the cause |
