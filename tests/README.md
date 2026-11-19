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
- The prompts of an agent run are written by the Human, in the words a real user would type. An agent never edits one to make a test pass.

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
