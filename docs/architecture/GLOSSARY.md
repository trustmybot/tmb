# Glossary

The words tmb uses, and the plugin's word for the same thing. tmb prefers the name a developer already knows.

## Renamed

| tmb | Plugin | Why |
|---|---|---|
| Code graph | World model | The common name for an index of symbols and their links. |
| Index (`tmb index`) | Scan | What building a code graph is usually called. |
| Init (`tmb init`) | The first half of onboard | The word git, npm and cargo use for preparing a folder. It asks nothing. |
| Onboard (`tmb onboard`) | Onboard | Kept from the plugin, for tmb's settings only. The planner also onboards a project by itself at the first session with empty settings. |
| Planner | bro, as a role | Says what the role does. bro stays as the planner's name in conversation. |
| Worker | swe | Says what the role does, for any kind of task. |
| Reviewer | code-reviewer | Shorter. |
| Docs task | No-code task | Says what it is. |
| Base branch | Working branch, PR target | The name git hosts use for the branch a pull request merges into. |
| Start a task | Provision a task | Plain. |
| Host | Claude Code | tmb is not tied to one agent program. |

## Kept

| Word | Meaning |
|---|---|
| Trajectory | The record of the work. The term is used in agent research for the sequence of an agent's steps. |
| Agile mode | One review per feature branch. |
| Truest mode | A review of every task before its push. |
| In review | A truest task whose checks passed and whose review has not passed yet. |
| Feature branch | A long-lived branch that collects a milestone's tasks. |
| Issue, task, milestone | As in [WORKFLOW.md](WORKFLOW.md#units-of-work). |
| Harness | tmb as a whole: the record, the code graph, and the workflow with the gate that enforces it, around the agents a host runs. It is not the program that runs the model; that is the host. |
| Gate | What stops a step that the workflow does not allow. |
| Concept | An agent-written note in the code graph, anchored to code. |
| The Human | The developer tmb works for. |

## Not carried over

Lane, roundtable, cheatcode, headless shim, sandbox setup, research switch.
