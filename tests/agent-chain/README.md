# Agent chain tests

A real host agent across several sessions on one record. They use the host under a subscription login, and run on request ([all layers](../README.md)). Prompts and unattended mode follow the [agent run rules](../agent-run/README.md#prompts).

| Test | Run | What it proves |
|---|---|---|
| [run.ts](run.ts) | `bun run test:chain` | bro records an issue, and a new session picks it up. |
| [feature.ts](feature.ts) | `bun run test:chain:feature` | Two sessions each ask for one more function; one feature branch collects both tasks, passes its tests and is backed up on origin. |

These tests become steps of the [whole chain](../chain/README.md) (trustmybot/tmb#260).
