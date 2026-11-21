# Git workflow

Where the work sits at every stage of a tmb task, what the engine does in git, what the push gate lets leave the machine, and how a workspace of several repos decides which repo a step belongs to. [FLOWS.md](FLOWS.md) shows the task chain this serves, from the Human's ask to the merge.

## Core principle: local is canonical, origin is downstream

The local branch is the source of truth at every step. A worker commits in its task's worktree, and the work reaches origin only through a push the engine makes. No worker or reviewer pushes.

tmb watches no git step on the way. It judges what leaves the machine: git's own pre-push hook asks the engine about every push, an agent's or one typed by hand.

The engine, not an agent, creates branches and worktrees, runs checks, folds a task into its feature branch, pushes and opens pull requests. Agents ask for these through the engine's tools, so every step is recorded and no agent is trusted to follow a git procedure.

## Actors and stages

- **The Human and the planner** work in the project's main folder, which stays on its branch for the whole task.
- **A worker** works only in the task's worktree, on the task's branch.
- **Origin** is the remote. The base branch is the branch pull requests merge into.

Agile mode, the recommended one:

| Where | Idle | Task started | Worker committed | Task closed | Milestone | After the merge |
|---|---|---|---|---|---|---|
| **Main folder** | its branch | unchanged | unchanged | unchanged | unchanged | unchanged |
| **Task worktree** | none | on the task branch, cut from the feature branch's tip | commits advance the task branch | removed with the task branch | none | none |
| **Feature branch** | cut from the base branch | unchanged | unchanged | moved to the task's commit | base branch merged in, then reviewed | kept; recorded as merged |
| **Origin** | base branch | same | same | feature branch pushed as a backup | reviewed tip pushed; one pull request | base branch advanced |

Truest mode has no feature branch: the task branch is cut from the base branch, waits in review at its commit with its worktree kept, and is pushed only for its own pull request, after a pass or a waiver. [3_WORKFLOW.md](3_WORKFLOW.md) covers both modes.

## Key handoffs

- **The engine provisions.** Starting a task cuts its branch and adds its worktree in one step. When git cannot add the worktree, nothing is recorded and what was made is removed. The main folder never switches branches.
- **A worker starts only on a ready task.** The gate refuses a worker start that names no open task with its worktree on disk.
- **A worker's own folder is adopted.** A host may start each worker in a worktree of the host's making. When the worker first reads its brief there, the engine makes that folder the task's worktree, if it is clean and belongs to no other task. Otherwise the task keeps the worktree the engine cut ([HOSTS.md](../architecture/HOSTS.md)).
- **No planner-side merge.** A fold moves the feature branch to the task's commit. When another task folded first, the engine rebases the later task onto the new tip and runs every check again.
- **Cleanup.** A close removes the task's worktree and branch. Both stay when the worktree holds uncommitted changes, untracked files git does not ignore, or a lock set by the host; the close names them. Files git ignores go with the worktree. tmb tries a kept worktree again at the planner's session start, when no task is open or in review. A truest task's branch stays for its pull request, and a dropped task's branch stays while it holds commits.
- **tmb deletes no feature branch.**

## Why this design

A branch can be checked out in only one worktree at a time. The task's worktree owns the task branch, and the main folder stays where it is, so there is never a second checkout to reconcile.

Routing a worker's commits through local branches, rather than letting it push, keeps the usual model: the Human can inspect, rebase or drop anything before it reaches origin.

## Keeping the base fresh

```mermaid
flowchart TD
    A[A feature branch is about to be cut] --> B[Engine fetches the base branch from origin]
    B --> C{"Local base branch holds a commit origin lacks, or there is no origin?"}
    C -- yes --> L[Cut from the local base branch]
    C -- no --> O["Cut from origin's base branch"]
    B -- "the fetch fails" --> K["Cut from what git already holds of origin's"]
    TT[A truest task is about to be cut] --> TB["Fetched the same way; cut from origin's base branch, the local one only with no origin"]
    T[An agile task is about to be cut] --> F["Cut from the feature branch's tip"]
    M[The base branch moves later] --> U{Mode?}
    U -- agile --> V[Planner has the engine merge it into the feature branch before the review]
    U -- truest --> W[Engine rebases the reviewed task before its first push]
```

- **A new branch never reuses a name.** A feature branch whose name already exists is refused.
- **The brief says whether a feature branch holds the base,** so the planner and the reviewer know before the review.
- **The code graph follows the branches.** Each lookup first brings the graph to the newest commit of what it reads: the base branch, a feature branch's tip or an open task's commit.

## Git guards

tmb has none. It reads no shell command to find a commit, a merge, a checkout or a push, and it blocks no direct commit. A list of every way to write a git command has no end; git already says exactly what a push sends.

What stands in their place, each at a checkpoint:

- **The close** runs the checks on the committed work and reports what changed outside the spec and in the main folder.
- **The review** judges the diff.
- **The push gate** below judges every push.
- **One host event stays:** a worker's start is refused without a ready task ([HOSTS.md](../architecture/HOSTS.md#containment)).

## Rebasing a reviewed task

Truest mode only. The rebase runs before the first push, in the task's own worktree.

```mermaid
flowchart TD
    A[A pass or a waiver covers the task; the planner asks for its pull request] --> B{Base branch moved since the task was cut?}
    B -- no --> P[Engine pushes the task branch and opens its pull request]
    B -- yes --> R[Engine rebases the reviewed commit onto the newest base]
    R -- conflict --> X[Rebase undone; the task reopens for its worker]
    R -- "the base already holds the change" --> N[Task closed with no pull request]
    R --> C{"The checks pass on the rebased commit?"}
    C -- no --> X
    C -- yes --> S{Same change as the reviewed one?}
    S -- yes --> K[The pass carries over, recorded in the audit trail]
    K --> P
    S -- no --> V[Task stays in review at the rebased commit: a fresh review]
```

- **The same change keeps its pass,** the way Gerrit carries a vote across a trivial rebase. Any other new commit needs a fresh review.
- **A failed rebase leaves the worktree as it was.**
- **No remote.** The task is rebased onto the local base branch the same way, then recorded ready: its worktree goes, its branch stays, and the Human merges it locally.

### When the base moves after the PR is open

An open pull request is never rebased, because that would rewrite what was pushed.

```mermaid
flowchart TD
    A["The base moves while a pull request is open"] --> B{Mode?}
    B -- truest --> C[The task branch is left alone]
    B -- agile --> D[Planner has the engine merge the base into the local feature branch]
    D -- conflict --> E[Nothing changes; settled in a task, or raised to the Human]
    D --> F[Not pushed while the pull request is open]
    F --> G[The new tip is reviewed or waived]
    G --> H[The pull request step pushes it to the same pull request]
```

- **The pull request is kept.** tmb opens no second one, so the review thread and history stay in one place.
- **Nothing is force-pushed.**

## The push gate at git's own hook

git hands its pre-push hook the exact refs and commits of a push, so the gate reads no command text and no shell form can hide a push from it. The hook runs inside the repo being pushed, so the policy is that repo's.

```mermaid
flowchart TD
    A[Any push, in any shell form, by an agent or by hand] --> B["git runs the repo's pre-push hook with the refs it sends"]
    B --> C{"The project's record?"}
    C -- none --> N1[Allowed, and the hook says so in one line]
    C -- "damaged or unreadable" --> X0[Denied]
    C -- readable --> D{Repo registered and not exempt?}
    D -- no --> N2[Allowed: tmb has no policy for it]
    D -- yes --> E{"A ref deletes the base branch?"}
    E -- yes --> X1[Denied]
    E -- no --> M{"The repo's review mode?"}
    M -- agile --> G{A ref pushes to the base branch?}
    G -- no --> OK1["Allowed: feature backups and the Human's own branches go freely"]
    G -- yes --> I{"Every commit it brings is held by a covered tip?"}
    M -- truest --> H{"A ref to the base brings an uncovered commit, or any ref brings a task's uncovered commit?"}
    H -- no --> OK2[Allowed]
    H -- yes --> X2[Denied, naming the commits and the next step]
    I -- yes --> OK3[Allowed]
    I -- no --> X2
```

- **Covered** means a pass or a Human waiver on that exact commit: a feature branch's tip in agile mode, a task's commit in truest mode, or a commit a pass was carried to by a rebase.
- **Only what the remote says it holds counts as already there.** A local ref can hold commits that never reached the remote.
- **Merge commits are left out.** They bring no change of their own.
- **The Human's push is judged too.** The gate holds whoever typed the push. In truest mode a commit of no task goes to a branch other than the base freely, so the Human's own branches need no waiver.
- **Every decision is recorded,** with who pushed. A push the engine makes for an agent names that agent; a push with no name is the Human's.
- **The gate denies when it cannot read the record.** A record file that is there but empty counts as damaged. With no base branch set, no push is judged.
- **The hook names its project.** Setup writes the project's folder into the hook, relative to the repo's top, so the gate never searches for it. A project may be one package of a monorepo, below the top where git runs the hook. One repo holds one tmb project: setup refuses a second one and says why.
- **A hook that is another tool's is left alone,** as husky and lefthook write. The gate is off there, and setup, every session start and the health check say so until the gate is on or the repo is exempt. With the Human's yes, tmb adds one line first in that hook, so the gate sees every pushed ref before the rest runs. The line is safe to commit: it calls the program by name, does nothing where the program is not installed, and hands the same refs on. tmb changes only a hook written for a shell; for one in another language it says how to call the gate by hand. A tool that rewrites its hook on every install drops the line, and the next session start says the gate is off again.
- **Removing tmb deletes the hook it wrote,** or takes out its one line. A hook that is not tmb's stays.
- **Linked worktrees share the hook.** A push from a task's worktree is judged as one from the repo it was cut from.
- **A mark on GitHub.** A local hook can be skipped, so the gate also has a place on the server. Each verdict or waiver sets a commit status named tmb/review on that exact commit: success for a pass or a waiver, failure for a fail. The repo's branch protection can require it before a merge. tmb says whether the base branch requires it and how to turn that on, and never changes the protection settings: they are the Human's. A mark that could not be sent is sent at the next review, waiver or pull request, and never fails the review. It is sent with the Human's own GitHub command line, only when origin is a GitHub repo. It is a convention among people who can write to the repo, not proof.
- **The remote host is the last line of defence.** tmb's hook does not replace the branch rules the Human sets there.

The health check counts the commits on each base branch that went around tmb. Planned: a gate that was skipped is found by the sync with the remote and recorded as a finding (trustmybot/tmb#70).

## Agile feature branches

In agile mode a long-lived feature branch stands between the task branches and the base branch. Each task branch is cut from its tip and folds back into it locally, with no pull request. The engine pushes it as a backup and merges the base branch into it before the review. Only the feature branch reaches the base branch, as one pull request after a pass or a Human waiver. [3_WORKFLOW.md](3_WORKFLOW.md) covers every case.

## Multi-repo workspaces

A project is a set of repos sharing one record. Setup decides which shape it is:

```mermaid
flowchart TD
    A[Setup runs in a folder] --> B{In a git work tree?}
    B -- yes --> ONE[A project of one repo: the folder itself]
    B -- no --> C{Holds git repos, up to two folders down?}
    C -- no --> GI[Setup makes the folder a git repo and says so]
    GI --> ONE
    C -- yes --> WS[A workspace: its repos share one record in that folder]
    WS --> F{Each top-level folder}
    F -- "a repo" --> R["Recorded with its own policy: base branch and checks"]
    F -- "no repo, and holds none" --> NR[Recorded as not a repo; left alone]
    R --> EX{Exempt?}
    EX -- yes --> LA[Listed and left untouched]
    EX -- no --> MG[Managed: push hook written, code graph indexed]
```

- **What counts as a repo.** A folder whose git folder is a real folder. A linked worktree or a submodule is never one, so a task's worktree is not taken for a repo. Setup does not look inside a repo it found, a dot-folder or a dependency folder.
- **The record keeps the set,** so no later step scans or guesses. Running setup again adds what appeared and drops what is gone, with a line for each.
- **A folder inside a git work tree is a project of one repo,** even when it holds nested repos.

tmb then resolves "which repo does this step belong to" from the work, never from the folder a session runs in:

1. **A feature branch or a task records its repo.** With one managed repo it may be left out; with several, a start that names none is refused with the list. An agile task works in its feature branch's repo. Every later step runs there: the cut, the worktree, the checks, the fold, the backup push and the pull request.
2. **Policy is per repo.** Each repo has its own base branch and checks, taken from its own git at setup: origin's default branch, else the current branch. A policy set before is kept. Each repo pushes to its own origin and opens pull requests on its own remote repo. The project-wide base branch and checks are not read in a workspace.
3. **One record.** Task worktrees stay under the workspace, so a worker finds the shared record. Feature names are unique in the record. Issues live in the record and name no repo.
4. **Each repo has a mode.**

   | Repo mode | What applies in the repo |
   |---|---|
   | Agile | Feature branches, tasks, the review of the whole branch, the push gate ([3_WORKFLOW.md](3_WORKFLOW.md)) |
   | Truest | Tasks cut from the base branch, a review of every task before its push, the push gate |
   | Exempt | Listed in the record and left untouched: no task, no hook, no code graph, no push gate. For a repo tmb does no work in, such as fixtures that never ship |

   - **The workspace has one review mode, and a repo can name its own.** One that names none follows the workspace's ([3_WORKFLOW.md](3_WORKFLOW.md#where-the-review-mode-is-set)). Everything that reads the mode reads the repo's: starting work, the push gate, the session start and the health check.
   - **Only the Human chooses a repo's mode,** as for the workspace's. In unattended mode a repo's mode is not changed.
   - **Its mode shows.** The settings and the planner's session start list each repo with its base branch and its mode.
5. **The gate in each repo.** Setup writes the pre-push hook into every managed repo. The hook names the workspace's folder: the gate reads the record there and judges the push against that repo's base branch and mode. A push from a repo the record does not register, or registers as exempt, is allowed, and the recorded reason says why.
6. **A code graph per repo,** built from its own base branch, with paths relative to that repo. A repo that cannot be indexed yet says why, and the others go on.

A global default repo would force one repo to be "the" repo; it breaks as soon as a second joins. Recording the repo on the work lets sibling repos sit side by side with none treated as the main one.

## Open, for the Human

- **Whether a truest task skips the local rebase where the remote has a merge queue.**
