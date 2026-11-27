# tmb Workflows

The list of every flow of tmb, in the order it runs: one line per flow, its state, the page that holds its steps, and one chart of its ideal case.

```mermaid
flowchart LR
    G1["1. Install"] --> G2["2. Cold start"]
    G2 --> G3["3. Agent task handling"]
    G3 --> C["Checkpoints: task close, review, push"]
    C --> M["Human merges"]
    G4["4. Extending the team (Planned)"] -.-> G3
    G5["5. Reporting tmb bugs"]
```

## How this page works

| Rule | What it means |
|---|---|
| **Ground truth** | This page is the ground truth for which flows exist. A PR that changes a flow updates its line here, and its steps page, in the same PR. |
| **Ideal case here, the rest in the page** | Each flow has one line and one chart of its ideal case here. Every other case, failures included, and how to debug it are in the page its line links. |
| **Numbers stay** | Flows are grouped by when they run and numbered within their group. Other pages cite a flow by its number, such as flow 1.1. |
| **Planned is marked** | Behaviour that is decided but not built is marked Planned, with its GitHub issue. |
| **One test per flow** | Planned (trustmybot/tmb#300): every flow has one scenario test of its ideal case. A change that breaks the flow fails that test, so the flow and the code cannot drift apart unseen. |

The three checkpoints are in [ENGINE.md](../architecture/ENGINE.md), and who owns each check is in [3_TASKS.md](3_TASKS.md).

## Every flow

| # | Flow | What happens | State | Steps |
|---|---|---|---|---|
| 1.1 | [Install and session start](#11-install-and-session-start) | The Human installs tmb in one step and runs `tmb init` once per project. Every session start then briefs the planner from the record. | Built | [1_INSTALL.md](1_INSTALL.md) |
| 1.2 | [Updates and channels](#12-updates-and-channels) | An install follows one channel and updates itself. A running session keeps its build while a task is open. | Built | [1_INSTALL.md](1_INSTALL.md#upgrade) |
| 1.3 | [Move a plugin project](#13-move-a-plugin-project) | `tmb migrate` copies a plugin project's records into tmb's record, one way, and leaves the plugin's database unchanged. | Built | [1_INSTALL.md](1_INSTALL.md#move-a-plugin-project) |
| 2.1 | [First contact](#21-first-contact) | At the first session with empty settings, the planner applies the base branch and the checks it recommends, and asks the Human for the review mode. No task starts before the answer. | Built | [2_ONBOARD.md](2_ONBOARD.md) |
| 2.2 | [Index and code-graph refresh](#22-index-and-code-graph-refresh) | `tmb init` or `tmb index` builds a code graph per repo from its base branch. A lookup that finds the graph behind brings it forward first. | Built | [2_CODE_GRAPH.md](2_CODE_GRAPH.md) |
| 2.3 | [Environment profile](#23-environment-profile) | tmb suggests a repo's checks from the files its stack leaves behind. The planner applies them, or the Human replaces them. | Built | [2_ONBOARD.md](2_ONBOARD.md#the-repos-checks) |
| 3.1 | [Code task](#31-code-task) | The planner writes the spec, a worker implements, the engine runs the checks at close, the reviewer reviews, and the Human merges. | Built | [3_TASKS.md](3_TASKS.md) |
| 3.2 | [Docs task](#32-docs-task) | The planner writes a docs or prompts change itself, in a task marked docs. It passes the same checks and the same review. | Built | [3_TASKS.md](3_TASKS.md) |
| 3.3 | [Push gate](#33-push-gate) | A push is refused unless the record holds what the repo's review mode requires for its commits: a reviewer's pass or the Human's waiver. | Built | [3_TASKS.md](3_TASKS.md) |
| 3.4 | [Retry and escalation](#34-retry-and-escalation) | A failed check, a review fail or a conflict sends the work back to its author without waiting on the Human. | Built | [3_TASKS.md](3_TASKS.md) |
| 3.5 | [PR comment triage](#35-pr-comment-triage) | A sync with the remote brings review comments into the record, and the planner sorts them into tasks on the pull request's branch. | Planned (trustmybot/tmb#70) | [3_TASKS.md](3_TASKS.md) |
| 3.6 | [Multi-repo workspaces](#36-multi-repo-workspaces) | `tmb init` in a folder that holds several repos gives them one record. A feature or a task names its repo, and every later step runs there. | Built | [3_GIT.md](3_GIT.md) |
| 3.7 | [Bulk cleanup](#37-bulk-cleanup) | `tmb doctor` lists what tmb left on disk, and `tmb doctor --fix` removes each item on the Human's yes. | Built | [1_INSTALL.md](1_INSTALL.md#debugging) |
| 3.8 | [Parallel lanes](#38-parallel-lanes) | Several sessions work in one project at once, each from the shared record, with a branch and a worktree per task. tmb keeps no lane record. | Built | [ROLES.md](../architecture/ROLES.md#parallel-lanes) |
| 3.9 | [Agile mode](#39-agile-mode) | Tasks close on their checks and fold into one feature branch per milestone. The branch is reviewed once and merges as one pull request. | Built | [3_WORKFLOW.md](3_WORKFLOW.md) |
| 3.10 | [Truest mode](#310-truest-mode) | Each task is cut from the base branch, is reviewed after its checks pass, and gets its own pull request. | Built | [3_WORKFLOW.md](3_WORKFLOW.md) |
| 3.11 | [Project with no remote](#311-project-with-no-remote) | Nothing is pushed and no pull request opens. Reviewed work is recorded as ready, and the Human merges it locally. | Built | [3_WORKFLOW.md](3_WORKFLOW.md), [3_GIT.md](3_GIT.md) |
| 3.12 | [Unattended run](#312-unattended-run) | A run with no one to answer applies the planner's defaults and records each as a decision. The checkpoints allow and refuse as in a normal session. | Built | [ENGINE.md](../architecture/ENGINE.md#unattended-mode) |
| 3.13 | [Several hosts on one record](#313-several-hosts-on-one-record) | Each host connects to the same record and takes a role, such as a planner on one host and a reviewer on another. The record is the handoff. | Built | [ADAPTERS.md](../architecture/ADAPTERS.md#different-models-on-one-task) |
| 4.1 | [Cheatcode lifecycle](#41-cheatcode-lifecycle) | The planner finds and vets a published skill for a capability gap, and the Human approves each install. | Planned (trustmybot/tmb#112) | [4_EXTENDING.md](4_EXTENDING.md) |
| 4.2 | [Agent creation](#42-agent-creation) | The planner drafts an agent for a role the project has none for, and the Human approves it. | Planned | [4_EXTENDING.md](4_EXTENDING.md) |
| 4.3 | [Skill creation](#43-skill-creation) | A recurring pattern becomes a project skill: the planner drafts, the Human approves. | Planned | [4_EXTENDING.md](4_EXTENDING.md) |
| 4.4 | [Consultant invocation](#44-consultant-invocation) | The Human asks for a second opinion. A consultant advises, the planner reports, and the Human decides. | Planned | [4_EXTENDING.md](4_EXTENDING.md) |
| 5.1 | [Bug report](#51-bug-report) | When tmb itself breaks, or on `tmb feedback`, the Human reads a cleaned draft. Nothing is sent without the Human's yes. | Built | [1_INSTALL.md](1_INSTALL.md#bug-reports) |

## Ideal cases

One chart per flow. No other page repeats these charts: the steps page holds the cases beyond the ideal one.

### 1.1 Install and session start

```mermaid
flowchart LR
    A["Human installs tmb in one step"] --> B["tmb init in the project"]
    B --> C["Record created; adapter writes the host's tools, roles and events"]
    C --> D["git's pre-push hook added; code graph indexed"]
    D --> E["Human opens the host in the project"]
    E --> F["Session start: the engine briefs the planner from the record"]
    F --> G["First session: 2.1 First contact"]
```

### 1.2 Updates and channels

```mermaid
flowchart LR
    A["Session start, at most once an hour, or tmb update"] --> B["Look for a newer build on this channel"]
    B --> C["Download in the background, verify, keep"]
    C --> D["Install at the session's end, or on tmb update"]
    D --> E["A running session moves at its next tool call, once no task is open"]
    E --> F["Next session start with no task open: the project's wiring is refreshed and the refresh recorded"]
```

### 1.3 Move a plugin project

```mermaid
flowchart LR
    A["tmb init in the project"] --> B["tmb migrate"]
    B --> C["Plugin records copied into tmb's record"]
    C --> D["Plugin database left unchanged"]
```

### 2.1 First contact

```mermaid
flowchart LR
    A["Session start: settings are empty"] --> B["Engine tells the planner what it found in the project"]
    B --> C["Planner applies the base branch and checks it recommends, and shows them"]
    C --> D["Planner asks the Human for the review mode, agile recommended"]
    D --> E["Human's answer stored, with who chose it"]
    E --> F["Tasks can start"]
```

### 2.2 Index and code-graph refresh

```mermaid
flowchart LR
    A["tmb init, tmb index, or a lookup that finds the graph behind"] --> B["Read each repo at its base branch commit"]
    B --> C["Parse only the files that changed"]
    C --> D["File summaries, symbols and their links"]
    D --> E["The lookup is answered from the fresh graph"]
```

### 2.3 Environment profile

```mermaid
flowchart LR
    A["Planner needs a repo's checks"] --> B["Engine suggests them from the repo's own files"]
    B --> C["Planner applies them, or the Human replaces them"]
    C --> D["Stored as the repo's checks"]
    D --> E["Run at every task close"]
```

### 3.1 Code task

```mermaid
flowchart LR
    A["Human asks"] --> B["Planner grounds it and records the issue"]
    B --> C["Planner writes the spec; engine cuts the task's branch and worktree"]
    C --> D["Host starts a worker; it implements and closes"]
    D --> E["Checks pass on the task's commit"]
    E --> F["Review, per the review mode: 3.9 or 3.10"]
    F --> G["3.3 Push gate: pass; pull request opens"]
    G --> H["Human merges"]
```

### 3.2 Docs task

```mermaid
flowchart LR
    A["Human asks"] --> B["Planner grounds it and records the issue"]
    B --> C["Planner starts a docs task"]
    C --> D["Planner edits and closes"]
    D --> E["Checks pass; only docs file types changed"]
    E --> F["Review, per the review mode: 3.9 or 3.10"]
    F --> G["3.3 Push gate: pass; pull request opens"]
    G --> H["Human merges"]
```

### 3.3 Push gate

```mermaid
flowchart LR
    A["Reviewer records a pass, or the Human a waiver"] --> B["Commit marked on GitHub"]
    A --> C["A push, tmb's own or typed by hand"]
    C --> D["git's pre-push hook asks the engine"]
    D --> E{"Record covers every commit?"}
    E -- yes --> F["Push goes"]
    E -- no --> G["Refused, with the reason"]
```

### 3.4 Retry and escalation

```mermaid
flowchart LR
    A["A check fails at close"] --> B["Close refused; names the check; task stays open"]
    C["Reviewer fails the work"] --> D["Task reopens, or the planner starts fix tasks"]
    E["A fold or a rebase conflicts"] --> F["Step undone; names the files"]
    B --> G["The author reworks: worker, or the planner on a docs task"]
    D --> G
    F --> G
    G --> H["Close again, then review again"]
    G -. wrong approach .-> I["Task dropped with a reason; a new task replaces it"]
```

### 3.5 PR comment triage

```mermaid
flowchart LR
    A["Comments reach a PR tmb opened"] --> B["Sync brings each into the record once"]
    B --> C["Planner groups the task-worthy ones"]
    C --> D["3.1 or 3.2 per group, on the PR's branch"]
    D --> E["New tip reviewed, then pushed to the same PR"]
```

### 3.6 Multi-repo workspaces

```mermaid
flowchart LR
    A["tmb init in a folder that holds repos"] --> B["Every top-level folder recorded: repo, exempt, or not a repo"]
    B --> C["Per managed repo: base branch, checks, optional review mode"]
    B --> D["Per managed repo: pre-push hook and its own code graph"]
    C --> E["A feature or task names its repo"]
    D --> E
    E --> F["Every later step runs in that repo"]
```

### 3.7 Bulk cleanup

```mermaid
flowchart LR
    A["tmb doctor"] --> B["Lists leftovers, one line each"]
    B --> C["tmb doctor --fix asks about each"]
    C -- yes --> D["Removed"]
    C -- no --> E["Kept"]
    A -- "a tracked repo file" --> F["A task, as in 3.1 or 3.2"]
```

### 3.8 Parallel lanes

```mermaid
flowchart LR
    A["Human asks for parallel work"] --> B["Planner splits it into independent issues"]
    B --> C["Host starts one session per stream"]
    C --> D["Each session's planner resumes from the shared record"]
    D --> E["Each runs 3.1 or 3.2 on its own issues, a worktree per task"]
    E --> F["Planner is told which open tasks share a file"]
    F --> G["PRs merge like any other; git settles a clash"]
```

### 3.9 Agile mode

```mermaid
flowchart LR
    A["Human approves a milestone's feature branch"] --> B["Engine cuts it from the base branch"]
    B --> C["Planner starts a task off it"]
    C --> D["Worker implements, or the planner writes docs"]
    D --> E["Checks pass: task closes with no review and folds in"]
    E --> F["Feature branch pushed as a backup, no PR"]
    F --> C
    F --> S["Milestone: base branch merged in"]
    S --> G["Reviewer reviews the whole branch"]
    G -- "pass, or Human waiver" --> H["One PR into the base branch"]
    H --> I["Human merges"]
    G -. fail .-> K["Fix tasks on the feature branch"]
    K -.-> G
```

### 3.10 Truest mode

```mermaid
flowchart LR
    A["Engine cuts the task branch from the base branch"] --> B["Worker implements, or the planner writes docs"]
    B --> C["Checks pass; the task waits in review"]
    C --> D["Reviewer reviews the task's commit"]
    D -- "pass, or Human waiver" --> E["Engine rebases if the base moved, pushes, opens the PR, closes the task"]
    E --> F["Human merges"]
    D -. fail .-> G["Task reopens; the worker reworks it"]
    G -.-> C
```

### 3.11 Project with no remote

```mermaid
flowchart LR
    A["Review passes, or the Human waives it"] --> B["PR step records the work as ready"]
    B --> C["Human gets the local merge command"]
    C --> D["Human merges into the local base branch"]
    D --> E["tmb sees the base branch holds the work"]
    E --> F["Recorded as merged, or the task closed"]
```

### 3.12 Unattended run

```mermaid
flowchart LR
    A["Run started in unattended mode"] --> B["Session start puts one instruction first: apply your defaults and name each"]
    B --> C["Planner answers its own questions with its recommendation"]
    C --> D["Each default recorded as a decision on its issue"]
    D --> E["Work goes on; the answer names the defaults"]
    C -. "no safe default" .-> F["Planner stops and says why"]
```

### 3.13 Several hosts on one record

```mermaid
flowchart LR
    A["tmb init once per host, each with a role"] --> B["Host one opens as the planner"]
    A --> C["Host two opens as the reviewer"]
    B --> D["Planner and workers build the work"]
    D --> E["Record: a branch waits for review"]
    C --> E
    E --> F["Reviewer host is briefed at session start and records its verdict"]
    F --> G["Same checks, same push gate"]
```

### 4.1 Cheatcode lifecycle

```mermaid
flowchart LR
    A["Capability gap"] --> B["Search registries"]
    B --> C["Vet the pick"]
    C --> D["Human approves"]
    D --> E["Skill given to a role"]
    E --> F["Every host in that role gets it"]
```

### 4.2 Agent creation

```mermaid
flowchart LR
    A["Role with no agent"] --> B["Up to three questions"]
    B --> C["Tailored draft"]
    C --> D["Human approves"]
    D --> E["Agent written for the host and registered"]
```

### 4.3 Skill creation

```mermaid
flowchart LR
    A["Recurring pattern"] --> B["Planner drafts the skill"]
    B --> C["Human approves"]
    C --> D["Skill lands in the project"]
```

### 4.4 Consultant invocation

```mermaid
flowchart LR
    A["Human asks for a second opinion"] --> B["Consultant started on the question"]
    B --> C["Analysis recorded on the issue"]
    C --> D["Planner reports, Human decides"]
```

### 5.1 Bug report

```mermaid
flowchart LR
    A["tmb itself breaks"] --> O{"Feedback on, or the Human ran tmb feedback?"}
    O -- no --> N["No offer"]
    O -- yes --> B["Cleaned draft"]
    B --> C["Human reads the full draft"]
    C -- no --> R["Dropped"]
    C -- yes --> D{"GitHub CLI signed in?"}
    D -- yes --> E["Filed to tmb's repo and recorded"]
    D -- no --> S["Bug form opens filled in; the Human submits; recorded as opened"]
```
