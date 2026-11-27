# tests

How tmb is tested. This page is the map: each layer's tests are described in the README of its own folder.

## The rule

A feature is done only when its tests pass with no manual step.

## Test layers

Ordered from cheap to costly.

| Layer | Folder | What it runs | Catches |
|---|---|---|---|
| Install | [tests/install](install/README.md) | The published compiled file, downloaded and started on a clean machine of each platform. | A file that does not download, start or update. |
| Lint | [tests/lint](lint/README.md) | Static checks on code, docs and prompts. | Type errors, broken links, a test file with no timeout. |
| Unit | [test](../test/README.md) | One engine rule at a time, called directly. | A wrong rule, a wrong record shape. |
| Integration | [tests/integration](integration/README.md) | The real engine process through a real door: the tool server, the command line, a host event passed through the adapter. | A rule that is right but unreachable: a tool the host cannot call, an event the adapter mistranslates. |
| Workflow simulation | [tests/workflow](workflow/README.md) | A whole flow as a scripted sequence of tool calls, with no model. | A workflow step that can be skipped or done out of order. |
| Agent run | [tests/agent-run](agent-run/README.md) | A real host agent given one prompt in a prepared project. | An agent that does not do what its prompt and tools should lead it to. |
| Agent chain | [tests/agent-chain](agent-chain/README.md) | A real host agent across several sessions on one record. | Work that is lost between sessions. |

Two more folders run beside the layers:

| Folder | What it runs |
|---|---|
| [tests/chain](chain/README.md) | The whole chain: one story from install to a shipped demo app, in a container. |
| [tests/benchmark](benchmark/README.md) | The code graph's scores on public repos, against each language's own tool. |

- A lower layer passing says nothing about the layer above it. Each layer catches what the ones below cannot see.
- Tests run from cheap to costly, and a failure stops the run.
- The layers from Install to Workflow simulation use no model and cost nothing. An agent run and an agent chain use the host under a subscription login, so they cost time and usage.
- The prompts of an agent run are written by the Human, in the words a real user would type ([agent-run](agent-run/README.md#prompts)). An agent never edits one to make a test pass.

## When each layer runs

| When | Layers |
|---|---|
| Every pull request | Lint, Unit, Integration, Workflow simulation, and the whole chain's steps that use no model |
| Every build published to the dev channel, and every rc or stable release | Install |
| On request | Agent run, Agent chain, the whole chain with its session steps |
| Before `dev` becomes an rc | The whole chain, session steps included, run by the Human on their own machine with their own login. It must pass there first; the run on GitHub comes after ([contributing](../docs/contributing/README.md)). |
| Before an rc or stable release | All of them. |

## Rules for every test

- **Every `bun test` file starts with `setDefaultTimeout(30_000)`.** bun's default of 5 seconds fails tests that start tmb, git or a server whenever the machine is busy, and bun cannot raise it for the whole run: the call holds only in the file that makes it. A test that needs longer names its own timeout, and a test that hangs still fails. [tests/lint/test-timeout.test.ts](lint/test-timeout.test.ts) names any file that leaves the call out.
- **No test fixes the OS, the model or the machine's setup.** Each is a setting of the run, so the same test runs unchanged on another OS, with another model, or on a machine set up differently. A test that only passes with one of them names it and says why.
- **Every test is TypeScript run by bun,** the same on every OS. Only the installers ([scripts/install.sh](../scripts/install.sh), [scripts/install.ps1](../scripts/install.ps1)) stay shell, because they run before tmb or bun is on the machine.
- **The Install, Agent run and Agent chain layers are plain scripts,** not `bun test` files. Each prints `PASS` or `FAIL` lines and exits 0 when it passes, 1 when it fails and 2 when it cannot run (no claude, tmb, git or bun). They share one module, [tests/lib/driver.ts](lib/driver.ts): temp folders removed on exit, a fixture copied into a fresh git project, `claude -p` in unattended mode with its answer saved, `tmb ... --json` read back, and git checks.

## The whole chain in a container

One empty Linux container, one demo app of three repos, and one chain of steps on one record, from install to pull requests, an update and the dashboard. A feature is done when the chain covers it: each new feature adds a step or a check, or its pull request says why not. How to run it, a step alone from a saved state included: [tests/chain](chain/README.md).
