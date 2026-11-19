# Architecture

The design of tmb. These docs state what the engine does and why. They name no functions, files or tables: code relationships belong to the code graph, and logic belongs to the code.

Each doc states the design as decided. A rule that is decided but not built carries a "Planned" note. A rule the Human has not confirmed carries "Proposed, for the Human's review".

## The shape

```mermaid
flowchart TD
    H[Human] --> Host[Host: an agent program such as Claude Code]
    H --> D[Dashboard]
    H --> C[Command line]
    Host --> A[Host adapter]
    A --> E
    D --> E
    C --> E
    subgraph E[Engine]
        W[Workflow and gate]
        T[Trajectory]
        G[Code graph]
    end
    E --> Git[git, checks, pull requests]
```

- The **host** runs the agents: its main agent plans, and it starts the workers and the reviewer as its own subagents, under the Human's own login.
- The **engine** holds the three pillars. It briefs the agents, records what they do, and decides what is allowed.
- The **host adapter** is the only part that knows a host. Claude Code is first; another host is another adapter ([HOSTS.md](HOSTS.md)).

## Docs in this folder

| Doc | Answers |
|---|---|
| [HOSTS.md](HOSTS.md) | How does tmb work with Claude Code without being built for it, and how do several agents run? |
| [WORKFLOW.md](WORKFLOW.md) | What path does work take from request to merge, and what stops a wrong step? |
| [TRAJECTORY.md](TRAJECTORY.md) | What is recorded, and how is work resumed from it? |
| [CODE_GRAPH.md](CODE_GRAPH.md) | How is the code graph built and queried? |
| [DISTRIBUTION.md](DISTRIBUTION.md) | How is tmb packaged, installed and updated? |
| [tests/README.md](../../tests/README.md) | How is tmb tested, and which tests does each level add? |
| [GLOSSARY.md](GLOSSARY.md) | What does each word mean, and what did the plugin call it? |

## Decided

Decided by the Human on 2026-11-18.

| Topic | Decision |
|---|---|
| Form | A standalone program. It is not a plugin of any agent. |
| Language | TypeScript, shipped as one compiled file per platform. |
| Platforms | macOS, Windows and Linux. |
| Hosts | Claude Code first, in its command line and its desktop app. No host is hardcoded: each is an adapter, so another such as Codex can be added. |
| Login | The Human's subscription to the host. No API key is needed. |
| Roles | The host's main agent is the planner. Workers and the reviewer are subagents the host starts. The engine briefs, records and gates them. |
| Different models | Each role can use a different model. Agents from different vendors work on one task by connecting their hosts to the same record. Planned, after the first host. |
| Records | Shareable from the first schema: history is kept as events, every record names the role and host that made it, and ids never collide across machines. |
| What tmb does not do | Start agents, run models or manage parallel sessions. The host does. |
| Agents left out of version 1 | DeepSeek Harness, as host or as worker. |
| Network | The engine works with no internet access. Running fully offline with local models needs a host that supports them. |
| Install and updates | One-step install. Three channels: dev, rc and stable. Updates are pushed to each channel. |
| Version 1 scope | What the TMB plugin does today, without the features the plugin has dropped and without anything that exists only for Claude Code outside its adapter. |
| Review modes | Agile is the default and is built first. Truest is built last. |
| Dashboard | Version 1 serves it as a local web page. Version 2 is a desktop program with the dashboard built in. |
| License | Functional Source License 1.1 with Apache 2.0 as the future license. Free for any use, including inside a company, except a competing commercial product or service. |
| Plugin projects | A fresh start. A one-way migration tool carries a plugin project's records over. |

## Build order

tmb is built in levels, from easy to hard. Each level unlocks one ability and ends in something the Human can try in a minute. Each level is a GitHub milestone, and its issues say which plugin code they reuse.

| Level | Unlocks | The Human sees it when |
|---|---|---|
| 0. Wake up | Download, install and cold start, with the smallest setup: one session start event. | Claude Code, opened in a project, answers as bro. |
| 1. Memory | The trajectory record, the project's database and tmb's tools. | Bro records an issue and a new session picks it up. |
| 2. Setup | Full setup with its questions, and the complete Claude Code adapter. | One command sets up a fresh project and another undoes it. |
| 3. Workers | Tasks, worktrees, workers as subagents, checks at close. | Bro hands a code task to a worker and it closes only when its checks pass. |
| 4. Agile mode | Feature branches, docs tasks written by the planner, contract tests. | A feature branch collects several tasks. |
| 5. Code graph | Indexing, lookups, and their use in scoping a task. | Bro scopes a task from the graph, not by reading files. |
| 6. Review and gate | The reviewer, the review of a whole feature branch, the pre-push gate, the Human's waiver. | A reviewer passes the branch and a wrong push is refused. |
| 7. Dashboard | The local web page over the record. | The work shows in a browser without asking an agent. |
| 8. Distribution | Three channels, pushed updates, the migration tool. | An install updates itself and a plugin project's records carry over. |
| 9. More hosts | A second host adapter, two hosts on one record, local models. | A second host reviews work on the same record. |
| 10. Truest mode | Review of every task before its push. | A task cannot be pushed unreviewed. |

- A level is done only when its tests pass with no manual step. The last column is one of those tests ([tests/README.md](../../tests/README.md)).
- After level 4, tmb's own development moves onto tmb. After level 10, version 1 is complete.
- Enforcement arrives in steps: the planner is guided by its prompt alone until level 3 brings checks at close, and level 6 brings the push gate.
- The packaging test runs at level 0, ahead of the levels that need what it tests, because a failure reopens the language decision ([DISTRIBUTION.md](DISTRIBUTION.md)).

## Reuse from the plugin

Most of the plugin's logic is host-neutral and carries over. What is tied to Claude Code is rebuilt as engine rules behind the adapter.

| Area | Verdict |
|---|---|
| Record store and its schema | Reuse, from a fresh first version with the dropped features' tables removed. |
| Workflow logic: issues, tasks, starting a task, close, review, feature branches, integrate | Reuse, called directly by the engine. |
| Code graph: parsing, symbols, graph, freshness, concepts | Reuse as is. |
| Search by meaning | Leave out at first: its model is the one part that needs a native module and a download. |
| Git's pre-push judge | Reuse as is. |
| Git and pull request helpers, issue sync | Reuse as is. |
| Dashboard, server and pages | Reuse, reading the engine's database. |
| Guards written as Claude Code hooks | Rebuild: the rules move into the engine, the adapter only translates events. |
| Shell command analysis for guards | Decide at level 6. |
| Role prompts and skills | Rewrite once, host-neutral. |
| Workflow tests that drive the tools end to end | Port as the engine's contract tests. |
| Roundtable, cheatcodes, lanes, headless shim, sandbox setup | Drop. |

## Open

- How much of the plugin's guard set levels 3 and 4 need, beyond checks at close.
- Which second host comes first.
