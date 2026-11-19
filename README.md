# tmb

tmb is a standalone engine that makes coding agents work as a team you can trust. Your agent program plans the work and starts the workers and the reviewer, and tmb records every step and lets nothing be pushed until it has passed the gate.

Status: design stage. No code yet. The design lives in [docs/architecture](docs/architecture/README.md).

## Three pillars

| Pillar | What it gives you |
|---|---|
| **Trajectory DB** | A record of every decision, task, review and result, so work can be traced and resumed. |
| **Code Graph** | A graph of the code, so agents find what they need without reading whole files. |
| **Workflow** | A fixed path from request to merge, in an agile mode and a strict mode, so you choose between speed and safety. |

## What it is for

- A heavier model plans; cheaper models do the work.
- Agents from different vendors work on one task: one plans, another writes, a third reviews.
- It runs on your subscription to the agent program, with no API key.
- It runs on macOS, Windows and Linux, and the engine needs no internet access.

## Relation to the TMB plugin

The [TMB plugin](https://github.com/trustmybot/plugin) for Claude Code is the first version of these ideas. tmb is a fresh start that is not tied to one agent program: Claude Code is supported first, through an adapter. A one-way migration tool will carry a plugin project's records over.

## Docs

| Folder | Holds |
|---|---|
| [docs/architecture](docs/architecture/README.md) | The design: what the engine does and why. |
| [docs/contributing](docs/contributing/README.md) | How work on this repo is done. |
| [docs/reference](docs/reference/README.md) | Install, upgrade and configuration, once there is something to install. |

## License

[Functional Source License 1.1, Apache 2.0 future license](LICENSE.md) (FSL-1.1-ALv2). You may use, change and share tmb for any purpose, including inside a company, except to offer it to others as a competing commercial product or service. Each release becomes Apache 2.0 two years after it is published.

tmb is source-available. It is not open source by the Open Source Initiative's definition until that two-year date.
