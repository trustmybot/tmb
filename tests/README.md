# tests

How tmb is tested, and which tests each level of the [build order](../docs/architecture/README.md#build-order) must add.

## The rule

A level is done only when its tests pass with no manual step. The line "The Human sees it when" in the build order is itself one of those tests: it is automated, so the Human does not have to try each level by hand.

## Test layers

tmb keeps the plugin's layers, ordered from cheap to costly. They are named here by what they do, because "level" already means a step of the build order. The plugin's own label is given for reference.

| Layer | Plugin's label | What it runs | Catches |
|---|---|---|---|
| Install | L0 | The published compiled file, downloaded and started on a clean machine of each platform. | A file that does not download, start or update. |
| Lint | L1 | Static checks on code, docs and prompts. | Type errors, broken links, version drift, a prompt over its size limit. |
| Unit | L2 | One engine rule at a time, called directly. | A wrong rule, a wrong record shape. |
| Integration | L3 | The real engine process through a real door: the tool server, the command line, a host event passed through the adapter. | A rule that is right but unreachable: a tool the host cannot call, an event the adapter mistranslates. |
| Workflow simulation | L4 | A whole flow as a scripted sequence of tool calls, with no model. | A workflow step that can be skipped or done out of order. |
| Agent run | L5 | A real host agent given one prompt in a prepared project. | An agent that does not do what its prompt and tools should lead it to. |
| Agent chain | L6 | A real host agent across several sessions on one record. | Work that is lost between sessions. |

- A lower layer passing says nothing about the layer above it. Each layer catches what the ones below cannot see.
- Tests run from cheap to costly, and a failure stops the run.
- The layers from Install to Workflow simulation use no model and cost nothing. An agent run and an agent chain use the host under a subscription login, so they cost time and usage.
- The prompts of an agent run are written by the Human, in the words a real user would type ([Prompts](#prompts)). An agent never edits one to make a test pass.

## Prompts

tmb is a product for users, so an agent run tests what a user would really type, not what the engine expects to hear.

- **Write as a user would.** Short and loose. Name the goal, not tmb's tools, records or steps.
- **Do not ask for a step tmb should take by itself.** If bro should record a goal without being told, a prompt that says "record this" tests nothing.
- **Be specific only where the test needs it.** A detail belongs in a prompt only when the check has to find it afterwards.
- **Add nothing for the test's sake.** A prompt holds only what a user would type. That no one is there to answer is said by the run, not by the prompt ([Unattended runs](#unattended-runs)).

| A user would type | Reads like a spec |
|---|---|
| `@bro we need a dark mode toggle` | `@bro record an issue titled "Dark mode toggle"` |
| `@bro where were we?` | `@bro what open work is in the record?` |

## Unattended runs

An agent run has no one to answer a question, so it runs tmb in unattended mode ([HOSTS.md](../docs/architecture/HOSTS.md#unattended-mode)): the engine tells bro at session start to apply its defaults and name the ones it used. The test sets the mode; the prompt never mentions it.

Unattended mode does not test whether bro asks a good question when a person is there. A test that needs that holds scripted replies, and the run resumes the session with one when bro asks. Planned, for the first level that depends on a question.

## When each layer runs

Proposed, for the Human's review.

| When | Layers |
|---|---|
| Every pull request | Lint, Unit, Integration, Workflow simulation |
| Every build published to the dev channel | Install |
| On request, and before a level is called done | Agent run, Agent chain |
| Before an rc or stable release | All of them |

## Tests each level adds

Each level's milestone holds one test issue with this list. A later level keeps every earlier level's tests passing.

| Level | Tests it adds |
|---|---|
| 0. Wake up | **Install:** the dev build downloads and starts on macOS, Windows and Linux with no login. **Lint:** types and links. **Integration:** a session start event passed through the adapter returns the planner's role and rules. **Agent run:** Claude Code, opened in a project, answers as bro. |
| 1. Memory | **Unit:** each record rule. **Integration:** every tool answers through the tool server and the command line. **Agent chain:** bro records an issue, and a new session picks it up. |
| 2. Setup | **Integration:** setup on a fresh project writes the three registrations and the database; removal restores the project and leaves the Human's own settings unchanged. **Agent run:** bro answers as bro after a full setup. |
| 3. Workers | **Unit:** task rules. **Workflow simulation:** a task cannot close until its checks pass. **Agent run:** bro hands a code task to a worker and it closes. |
| 4. Agile mode | **Workflow simulation:** the plugin's workflow flows, ported as contract tests. **Agent chain:** a feature branch collects several tasks across sessions. |
| 5. Code graph | **Unit:** parsing and lookups per language. **Integration:** the graph is current after a change. **Agent run:** bro scopes a task from the graph. |
| 6. Review and gate | **Integration:** the push gate refuses a push the record does not allow, including one typed by hand. **Workflow simulation:** review, fail, rework, pass, waiver. **Agent run:** a reviewer passes a feature branch. |
| 7. Dashboard | **Integration:** every page loads from a prepared record and shows its data. |
| 8. Distribution | **Install:** an install updates itself on each channel, and never in the middle of a task. **Integration:** a plugin project's records carry over. |
| 9. More hosts | **Integration:** one shared set of adapter tests that every host adapter must pass. **Agent chain:** a second host reviews work on the same record. |
| 10. Truest mode | **Workflow simulation:** a task cannot be pushed unreviewed. **Agent run:** one task from request to its pull request. |

## Level 4 tests

| Layer | Test | What it proves |
|---|---|---|
| Unit | [test/feature-branch.test.ts](../test/feature-branch.test.ts) | feature_start, the fold on close, the refusal of a task whose work is already on the feature branch, and the backup push. |
| Workflow simulation | [tests/workflow/feature-fold.test.ts](workflow/feature-fold.test.ts) | A code task and then a docs task fold into one feature branch in order. |
| Workflow simulation | The ported plugin flows, below. | Each flow's steps, refusals and record, through the tool server. |
| Agent chain | [tests/agent-chain/feature.sh](agent-chain/feature.sh) (`bun run test:chain:feature`) | Two sessions each ask for one more function; one feature branch collects both tasks, passes its tests and is backed up on origin. |

### The plugin's workflow flows

Each flow of the plugin's workflow simulation is ported once tmb has built what it tests, in tmb's own tools and rules. Until then it waits for the level that builds it.

| Plugin flow | tmb test or the level it waits for |
|---|---|
| 02 Simple task | [flow-02-simple-task.test.ts](workflow/flow-02-simple-task.test.ts) |
| 03 Difficult task | [flow-03-difficult-task.test.ts](workflow/flow-03-difficult-task.test.ts). tmb records a question and its answer as notes. |
| 06 Push gate | [push-gate.test.ts](integration/push-gate.test.ts). git's own pre-push hook judges every push, one typed by hand too, so it runs as an integration test with a real origin. |
| 08 Retry and escalation | [review-gate.test.ts](workflow/review-gate.test.ts) ports review, fail and rework. tmb keeps no retry count, so escalation is the planner's call, not a rule. |
| 09 Cold restart | [flow-09-cold-restart.test.ts](workflow/flow-09-cold-restart.test.ts). Its checks that only the reviewer records a verdict are in [review-gate.test.ts](workflow/review-gate.test.ts). |
| 10 Roundtable | Not planned: the roundtable is not carried over ([GLOSSARY.md](../docs/architecture/GLOSSARY.md#not-carried-over)). |
| 11 Concurrent sibling tasks | [flow-11-concurrent-siblings.test.ts](workflow/flow-11-concurrent-siblings.test.ts) |
| 12 Spec amend | Not planned: no level of the build order changes a started task's spec. |
| 13 Issue update | [flow-13-issue-update.test.ts](workflow/flow-13-issue-update.test.ts). tmb issues have no labels, so only the milestone, title and body move. |

## Level 6 tests

| Layer | Test | What it proves |
|---|---|---|
| Unit | [test/commands.test.ts](../test/commands.test.ts), [test/decide.test.ts](../test/decide.test.ts) | The command reader finds git and gh through quotes, prefixes, `sh -c` and `eval`; the host guards deny skipping git's hook, a push by a worker or the reviewer, a hand-made pull request, a subcommand that is not plain text, and a write outside an open task's worktree. |
| Integration | [tests/integration/push-gate.test.ts](integration/push-gate.test.ts) | Setup writes git's pre-push hook and remove deletes it. A push typed by hand that brings unreviewed commits onto the base branch is refused, and so is deleting it; a feature branch's backup push goes through; the base branch takes the branch once the reviewer passed its tip. |
| Workflow simulation | [tests/workflow/review-gate.test.ts](workflow/review-gate.test.ts) | Review, fail, rework, pass and the pull request on one feature branch, and a Human waiver on a second; only a reviewer run records a verdict, and only on the branch's tip. |
| Agent run | [tests/agent-run/reviewer.sh](agent-run/reviewer.sh) (`bun run test:reviewer`) | bro starts the reviewer on a finished feature branch, and the reviewer records a pass at its tip. |
| 14 Repo rename | Not planned: multi-repo workspaces, where a repo's name is recorded, are carried over in intent ([WORKFLOW.md](../docs/architecture/WORKFLOW.md#carried-over-from-the-plugin)) but no level of the build order adds them. |

## Level 7 tests

| Layer | Test | What it proves |
|---|---|---|
| Lint | `bun run typecheck` | The dashboard's pages type-check under their own [tsconfig](../dashboard/tsconfig.json), next to the engine. |
| Integration | [tests/integration/dashboard.test.ts](integration/dashboard.test.ts) | `tmb dashboard`, started from outside the repository over a [prepared record](integration/dashboard-record.ts), serves the page with its bundled script and Tailwind styles. Every API read returns the record. The Human's notes, decisions, edits, closes and reopens go through the engine's operations. A request to another host name, a change without the token and an edit from a stale page are refused. Every page (overview, issues, one issue, tasks, one task, runs and gate decisions, audit) is rendered against the running server and shows its data. |
