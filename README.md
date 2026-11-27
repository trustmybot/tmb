# tmb

**Coding agents you can trust with real work.** tmb sits beside Claude Code and makes its agents follow one path: plan, write, check, review, then push. It records every step, and nothing reaches your main branch until it has passed the gate.

Free. Runs on your Claude subscription, with no API key. Status: early, before v1.0.0.

## How it works

| Part | What it does |
|---|---|
| **The record** | Keeps every decision, task, check and review, so you can see what happened and pick up where you stopped. |
| **The code graph** | Maps your code, so an agent finds what it needs without reading whole files. |
| **The workflow** | One fixed path from request to merge. A gate checks each step before it runs, so the path holds even when an agent ignores its prompt. |

You talk to one planner. It writes the spec, workers write the code, and a reviewer that did not write the change judges it.

## What can you get

- **Work you can trace.** Every task has a spec, its checks, a review and a result, all in one record on your machine.
- **Less spent on review.** A reviewer alone is not a gate: in [our study](https://arxiv.org/abs/2611.33639), every reviewer setting still accepted at least 45% of wrong patches. So tmb puts your project's own checks first and, in agile mode (the recommended one), reviews a whole feature branch once, not every commit.
- **Reviews that cost cents.** In the same study, a review by Claude Opus 5.5 cost about $0.09 on average. Anthropic's managed Code Review [averages $15–25](https://claude.com/blog/code-review). The two are not the same job, but the gap is the point.
- **Fewer tokens on reading.** The planner scopes a task from the code graph, and each worker starts from a spec that names the files in scope.
- **A heavier model plans, cheaper ones do the work.**
- **Your code stays with you.** The engine runs on your machine and needs no internet access. macOS, Windows and Linux.

## Who is tmb for

- **You use Claude Code every day** and want to hand it bigger tasks without checking every line.
- **You lead a project** and need to know what the agents did, and why.
- **You watch the bill** and want reviews and long sessions to cost less.

## Install

The stable channel installs the program `tmb`. macOS and Linux:

```sh
curl -fsSL https://github.com/trustmybot/tmb-releases/releases/download/dev/install.sh | TMB_CHANNEL=stable sh
```

Windows, in PowerShell:

```powershell
$env:TMB_CHANNEL = 'stable'; irm https://github.com/trustmybot/tmb-releases/releases/download/dev/install.ps1 | iex
```

No stable release is out yet. Until v1.0.0, install the dev channel from [tmb-releases](https://github.com/trustmybot/tmb-releases#channels).

Then, inside a project: `tmb init`. The rc and dev channels are on [tmb-releases](https://github.com/trustmybot/tmb-releases#channels); updates, setup and removal are in [docs/reference](docs/reference/README.md).

## Docs

| Folder | Holds |
|---|---|
| [docs/architecture](docs/architecture/README.md) | The design in space: the parts, what each owns and why. |
| [docs/flows](docs/flows/README.md) | The design in time: what tmb does, step by step. |
| [docs/prompt-engineering](docs/prompt-engineering/README.md) | The rules every prompt, role and skill follows. |
| [docs/contributing](docs/contributing/README.md) | How work on this repo is done. See also [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). |
| [docs/reference](docs/reference/README.md) | Install, set up and remove tmb. |

## License

[Functional Source License 1.1, Apache 2.0 future license](LICENSE.md) (FSL-1.1-ALv2). You may use, change and share tmb for any purpose, including inside a company, except to offer it to others as a competing commercial product or service. Each release becomes Apache 2.0 two years after it is published.

tmb is source available. It is not open source by the Open Source Initiative's definition until that two-year date.
