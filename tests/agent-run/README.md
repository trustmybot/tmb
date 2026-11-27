# Agent run tests

A real host agent given one prompt in a prepared project. They use the host under a subscription login, and run on request ([all layers](../README.md)).

| Test | Run | What it proves |
|---|---|---|
| [run.ts](run.ts) | `bun run test:agent` | Claude Code, opened in a project after init and onboard, answers as bro. |
| [worker.ts](worker.ts) | `bun run test:worker` | bro hands a code task to a worker and it closes. |
| [scope.ts](scope.ts) | `bun run test:scope` | Asked to change the loyalty discount, bro looks the code up in the code graph before it starts the task, and the task's files hold the file that defines the discount. |
| [reviewer.ts](reviewer.ts) | `bun run test:reviewer` | bro starts the reviewer on a finished feature branch, and the reviewer records a pass at its tip. |
| [truest.ts](truest.ts) | `bun run test:truest` | One task from request to its pull request: bro has a worker fix add, the reviewer pass it, and opens its pull request, with a fake `gh` standing in for GitHub. |

The drivers read `TMB_BIN` (the tmb to set up with, by default tmb on PATH), `TMB_AGENT_MODEL` (by default haiku) and, for one session, `TMB_AGENT_LOG` (where its answer is saved).

## Prompts

tmb is a product for users, so an agent run tests what a user would really type, not what the engine expects to hear. The Human writes each prompt, and an agent never edits one to make a test pass.

- **Write as a user would.** Short and loose. Name the goal, not tmb's tools, records or steps.
- **Do not ask for a step tmb should take by itself.** If bro should record a goal without being told, a prompt that says "record this" tests nothing.
- **Be specific only where the test needs it.** A detail belongs in a prompt only when the check has to find it afterwards.
- **Add nothing for the test's sake.** A prompt holds only what a user would type. That no one is there to answer is said by the run, not by the prompt.

| A user would type | Reads like a spec |
|---|---|
| `@bro we need a dark mode toggle` | `@bro record an issue titled "Dark mode toggle"` |
| `@bro where were we?` | `@bro what open work is in the record?` |

## Unattended runs

An agent run has no one to answer a question, so it runs tmb in unattended mode: the engine tells bro at session start to apply its defaults and name the ones it used. The test sets the mode; the prompt never mentions it.

Unattended mode does not test whether bro asks a good question when a person is there. A test that needs that holds scripted replies, and the run resumes the session with one when bro asks.
