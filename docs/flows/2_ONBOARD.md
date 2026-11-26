# First contact

Every case of flows 2.1 and 2.3 in [FLOWS.md](FLOWS.md): how tmb learns a project's shape, its policy and [its checks](#the-repos-checks). It takes two steps: a terminal step that asks nothing, and the planner's onboarding at the first session.

```mermaid
flowchart TD
    A[Human runs init in the project] --> B{In a git work tree?}
    B -- yes --> P1[A project of one repo]
    B -- "no, repos below" --> P2[A workspace: its repos share one record]
    B -- "no, none below" --> P3[init runs git init: one repo]
    P1 --> C[Record created, host wired, push hook added, code graph indexed]
    P2 --> C
    P3 --> C
    C --> D[Settings left empty; init says how they get filled]
    D --> E[First session: the engine tells the planner what is empty and what it found]
    E --> F[Planner works out the base branch and the checks, applies them and shows them]
    F --> G{Review mode set?}
    G -- yes --> J
    G -- "no, someone can answer" --> H[Planner asks the Human: each mode with its cost, agile recommended]
    H --> I[Planner stores the Human's answer]
    I --> J[Planner proposes the project's areas; the Human keeps some]
    G -- "no, unattended run" --> X[Stays unset: no task starts until the Human sets it]
    J --> K[Session starts say nothing more about settings]
```

`tmb onboard` sets the same settings from a terminal, and can be run again at any time. No task starts until the review mode is set.

## Steps

What first contact settles, and who settles it.

| Step | What happens | Who | Leaves |
|---|---|---|---|
| The project | No question. The record is the nearest one in the folder or above it. `tmb doctor` shows other records above or below. Init refuses a second project in a repo whose push hook already names another. | init | nothing |
| The remote | No question. tmb reads each repo's remote when it needs it: with none, nothing is pushed and no pull request opens ([3_GIT.md](3_GIT.md)). | engine | nothing |
| The base branch | Per repo: origin's default branch, else the current branch, else `main`. The review mode decides the branches ([3_WORKFLOW.md](3_WORKFLOW.md)). | init in a multi-repo workspace, else the planner; or `tmb onboard` | each repo's base branch |
| The host's role | Planner unless the Human names the reviewer; one role per host ([HOSTS.md](../architecture/HOSTS.md#different-models-on-one-task)). | init, or `tmb onboard` | the host and its role |
| Bug reports | The feedback program ([1_INSTALL.md](1_INSTALL.md#bug-reports)): on with a notice on dev and rc; on stable the planner asks once per machine. | init's last lines, or the planner | the person's setting, per machine and channel |
| The review mode | Agile or truest, the Human's choice. tmb recommends agile and never picks. In a multi-repo workspace: the workspace's mode once, then once whether any repo takes its own (trustmybot/tmb#216). | the planner's question, or `tmb onboard` on a terminal | the review mode, and how it was chosen |
| The push gate | No switch. Init installs the hook. Where a repo's pre-push hook is another tool's, the Human is asked whether tmb adds its one line first in it (trustmybot/tmb#184). A repo marked exempt gets none. | init; `tmb onboard` on a terminal | git's pre-push hook per repo |
| The checks | Found in the project and stored as a setting, not as a file in the repo ([The repo's checks](#the-repos-checks)). | the planner, or `tmb onboard` | the checks, per repo in a multi-repo workspace |
| The areas | Once the code graph is built, the planner proposes named parts of the project, one line each, and writes those the Human keeps ([CODE_GRAPH.md](../architecture/CODE_GRAPH.md)). | the planner | the areas |
| The design docs | Planned (trustmybot/tmb#302). Where the high-level design is, or in a project with none, where to keep it: a folder in the repo, a link outside it, or the record ([the three layers](../architecture/README.md#three-layers-of-knowledge)). | the planner's question, or `tmb onboard` | where the design is kept |
| Issue sync | Planned, inside the syncer (trustmybot/tmb#70). | | |

- **Init asks nothing.** It never waits for input, on a terminal or not (trustmybot/tmb#162). It sets the host and its role and, in a multi-repo workspace, each repo's base branch and found checks. Every other setting stays empty.
- **Onboarding happens by itself.** When a planner's session starts and the base branch, the review mode or the checks is empty, the engine says so, with what it found. The planner applies what it recommends before other work and shows it. It reminds the Human that `tmb onboard` can be run again, and that it can change a value when asked.
- **The review mode is the Human's choice** (trustmybot/tmb#114). It decides how many tokens a project uses. Three ways set it: the planner's question, `tmb onboard` on a terminal, or its review-mode flag with a typed yes. The record keeps which. It is a step only the Human may take ([HOSTS.md](../architecture/HOSTS.md#ways-into-the-engine)).
- **Unattended runs.** The planner applies its recommendations and names each value in its answer. It never sets the review mode, so the first task is refused and the refusal names `tmb onboard`. One exception: a run with no terminal may set a mode where none is set, never change one (trustmybot/tmb#223).
- **Re-runs keep what stands.** `tmb onboard` offers each stored value first and changes a setting only when the Human gives a new one. Init run again keeps every stored setting and, in a multi-repo workspace, each repo's policy; it adds repos that appeared and drops those that are gone, one line each. The same answers change no file and record nothing.
- **Every change is kept.** Each change to a setting is an entry in the record's audit trail, and the newest entry is the value in force.
- **Without a terminal `tmb onboard` never waits.** Each question takes its default, and the review mode stays as it is.
- **Repos come from init.** Init records every top-level folder of a workspace, repo or not, and finds repos up to two folders down. Later steps never scan or guess ([3_GIT.md](3_GIT.md#multi-repo-workspaces)).
- **Nothing lands in the repo's working tree** beyond the ignore lines: settings live in the record, so there is no file for the Human to commit.
- **Failures.** Init with no host installed stops and changes nothing. `tmb onboard` before init says so and changes nothing.

## The repo's checks

The checks are the commands that must pass before a task closes. tmb hardcodes no toolset: it finds a repo's checks at onboarding and stores them as a setting.

```mermaid
flowchart TD
    A[Onboarding needs a repo's checks] --> B["Detect: read the manifests and lockfiles; run nothing"]
    B --> C{Who sets them?}
    C -- "the planner, at the first session" --> D[Planner reads what it needs, applies the checks it recommends, shows them]
    C -- "the Human, on a terminal" --> E["Onboard offers the stored or found commands; the Human keeps, replaces or clears them"]
    C -- "init, in a multi-repo workspace" --> F[Each repo gets the checks found in it]
    D --> S[Stored as a setting, per repo in a multi-repo workspace]
    E --> S
    F --> S
    S --> T["A task closes: the stored checks run, then the task's own"]
    T --> U{All pass?}
    U -- yes --> V[The task closes]
    U -- no --> W[The close is refused and names the command]
    S -. the Human or the planner changes them at any time .-> S
```

- **Detect runs nothing.** It reads the files a stack leaves behind and suggests commands: a package manifest's lint, typecheck and test scripts, run with the tool its lockfile names, and the usual test command of a Python, Rust or Go project. It reads the repo's top folder only. The list is in the [reference](../reference/README.md#onboard).
- **A suggestion, never the rule.** The planner works out what it recommends from the suggestion and the project. The Human confirms or replaces it.
- **The repo is the source of truth.** Teammates, CI and editors enforce the same rules without tmb, so tmb suggests only commands the repo already defines.
- **A stored list is never overwritten by a new detection.** The checks change only when the Human or the planner changes them. A repo that changed keeps its stored checks until then.
- **One list per repo.** A project of one repo has one list. In a multi-repo workspace each repo has its own, and the project-wide list is not read ([3_GIT.md](3_GIT.md#multi-repo-workspaces)).
- **A task adds its own.** A task's spec can name more checks. At close the stored checks run first, then the task's, each with a time limit, in the task's worktree. A task with no checks at all never closes ([3_TASKS.md](3_TASKS.md)).

## How a card is written

The planner asks through its host's question tool. A person who has never used tmb must be able to answer from the card alone.

- **A card only when the Human must choose.** The planner applies the base branch and the checks without a card and shows them. It asks for the review mode, the areas to keep and, on stable, the feedback program.
- **One option is recommended, with its cost.** For the review mode: one option per mode with what it costs, agile marked as recommended. A card that asks for consent recommends nothing.
- **Repo modes are asked only in a multi-repo workspace.** A project of one repo takes the project's mode.

Planned:

- **The feature comes first.** The question opens by saying what tmb does here, in one or two sentences, and then asks.
- **tmb's own names.** A card uses the name tmb uses everywhere, such as docs task or review mode, and says what it means.
- **Each option says its benefit and its risk or cost**, in one short line.
- **The card shows the actual values.** Commands and branch names appear on the card, shortened with a count when the list is long.
- **Plain, short sentences.** Setting names and file formats stay off the card.
- **The planner recommends a mode per repo** from what each repo shows, with the reason beside it.
