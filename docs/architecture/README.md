# Architecture

The design of tmb. These docs state what the engine does and why. They name no functions, files or tables: code relationships belong to the world model, and logic belongs to the code.

Each doc states today's design. A rule that is decided but not built carries a "Planned" note.

## Decided

Decided by the Human on 2026-11-18.

| Topic | Decision |
|---|---|
| Form | A standalone program. It is not a plugin of any agent. |
| Language | TypeScript, shipped as one compiled file per platform. |
| Platforms | macOS, Windows and Linux. |
| Network | Works with no internet access and with restricted access, with local models only. |
| Install and updates | One-step install. Three channels: dev, rc and stable. Updates are pushed to each channel. |
| Roles | The host agent is the planner. The engine runs the workers and the reviewer. |
| Agents | Each role can use a different agent and model, from different vendors. |
| Agents left out of version 1 | DeepSeek Harness, as host agent or as worker. |
| Version 1 scope | What the TMB plugin does today, without the features the plugin has dropped and without anything that exists only for Claude Code. |
| Dashboard | Version 1 serves it as a local web page. Version 2 is a desktop program with the dashboard built in. |
| License | Functional Source License 1.1 with Apache 2.0 as the future license. Free for any use, including inside a company, except a competing commercial product or service. |
| Plugin projects | A fresh start. A one-way migration tool carries a plugin project's records over. |

## First step

A packaging test, before any design doc is written in detail: one compiled file that runs on macOS, Windows and Linux with no network, opens the database, parses code and starts an agent process. If it fails, the language decision is reopened.

## Open

Not decided. Each becomes a doc in this folder once it is.

- How the engine starts and talks to each agent.
- Where the gate lives, and how the host agent is held to the workflow.
- How the host agent, the command line and the dashboard reach the engine.
- Where a project's records are stored.

## Docs in this folder

None yet beyond this one. Planned, one per pillar and one per flow:

| Doc | Answers |
|---|---|
| TRAJECTORY.md | What is recorded, and how work is resumed from it? |
| WORLD_MODEL.md | How is the code graph built and queried? |
| WORKFLOW.md | What path does a feature or a bug take from request to merge? |
| AGENTS.md | How are agents from different vendors started, briefed and checked? |
| DISTRIBUTION.md | How is tmb packaged, installed and updated on each platform? |
