# DB enums

This page lists every set of allowed values in the record and the code graph, and the fixed vocabularies in tmb's code. A value follows an established convention where one exists and is invented only where none applies, the same rule as [`LABELS.md`](LABELS.md).

The engine, the role prompts and the planner decide what to do from these values, so a typo or an unannounced rename breaks them without a compile error.

**This page lists the values as the schemas and the code define them.** Planned: the [lint guard](#lint-guard) that compares it with the code.

## Where a vocabulary is enforced

A vocabulary is owned in one of three places:

- **By the engine, for the record.** The record's schema has no `CHECK` on a list of values ([`TRAJECTORY.md`](../architecture/TRAJECTORY.md#schema)). Its lists are in `src/engine/store/values.ts`, with the actor's lists in `src/engine/store/actor.ts`, and each record's fold checks them (`src/engine/store/projections.ts`).
- **By a `CHECK` in the schema, for the code graph** (`src/engine/graph/db.ts`).
- **By the code that writes it**, for the rest. `tasks.state`, `features.state`, `reviews.verdict`, and `runs.outcome` are such columns. Each table below names its source.

---

## Canonical ENUM tables

### `events.record_kind` — what an event is about

| Value | Projection table |
|---|---|
| `issue` | `issues` |
| `discussion` | `discussions` |
| `task` | `tasks` |
| `feature` | `features` |
| `run` | `runs` |
| `check_run` | `check_runs` |
| `review` | `reviews` |
| `guard_decision` | `guard_decisions` |
| `waiver` | `waivers` |
| `review_mark` | `review_marks` |
| `setting_change` | `setting_changes` |
| `freeze` | `freezes` |
| `feedback_report` | `feedback_reports` |
| `import` | `imports` |

The engine checks it.

### `events.type` — event type

| Value | Meaning |
|---|---|
| `created` | The record's first event; it makes the projection row |
| `updated` | A change to the columns the record kind allows to change. `discussion`, `review`, `guard_decision`, `waiver`, `setting_change`, `feedback_report` and `import` have none |

Owned by the code (`src/engine/store/projections.ts`); no `CHECK`.

### `events.actor_kind` and `actor_role` — who wrote

| Column | Value | Meaning |
|---|---|---|
| `actor_kind` | `human` | The Human. Carries no role and no host |
| `actor_kind` | `agent` | An agent. Carries a role and a host |
| `actor_kind` | `tmb` | tmb itself, for a write no person or agent made. Carries a source, and no role or host |
| `actor_role` | `planner` | The host's main agent, addressed as bro |
| `actor_role` | `worker` | The subagent that carries out one task |
| `actor_role` | `reviewer` | The agent that judges a branch or a task it did not write |

The engine checks it. `runs.role` takes the same three roles. A `tmb` actor has no role and names its source in `actor_source`: `syncer` or `upgrade`. A host's main agent takes one of two, `planner` or `reviewer` (the `host_roles` setting, [`CONFIG.md`](../architecture/CONFIG.md)).

### `issues.state` — issue lifecycle

| Value | Source | Meaning |
|---|---|---|
| `open` | GitHub | Newly created, not yet closed |
| `closed` | GitHub | Resolved |

These two states deliberately match GitHub's issue states. The engine checks it.

### `discussions.kind` — narrative kind in issue discussions

| Value | Source | Meaning |
|---|---|---|
| `note` | tmb | Running narrative on an issue |
| `decision` | tmb | A decision and its reason |

The engine checks it. `tmb migrate` leaves a plugin discussion of any other kind behind.

### `tasks.state` — task lifecycle

| Value | Source | Meaning |
|---|---|---|
| `open` | tmb | Started: its worktree is cut and a worker may run on it |
| `in_review` | tmb | A truest task whose checks passed at its commit; it waits for the reviewer, or for its pull request once passed |
| `ready` | tmb | A truest task in a repo with no remote whose review passed or was waived; the Human merges it locally |
| `closed` | tmb | Done |
| `dropped` | tmb | Ended by the planner or the Human without its work; `drop_reason` says why |

Owned by the code (`src/engine/handlers/common.ts`); no `CHECK`. [`3_TASKS.md`](../flows/3_TASKS.md) holds the lifecycle. `task_list` also takes `all` as a filter; it is not a state.

### `tasks.kind` — who writes the task

| Value | Meaning |
|---|---|
| `code` | The change touches code; a worker writes it |
| `docs` | The change touches only docs or prompts and no behaviour; the planner writes it itself |

Owned by the code (`src/engine/handlers/tasks.ts`). NULL on a task started before kinds.

### `tasks.review_mode` — the mode a task follows

| Value | Meaning |
|---|---|
| `agile` | Reviewed with its feature branch as a whole |
| `truest` | Reviewed on its own before its push |

The same two values as the `review_mode` setting. A task keeps the mode of its start. NULL reads as `agile`.

### `tasks.push_result` — the backup push at close

| Value | Meaning |
|---|---|
| `pushed` | The push to origin went through |
| `failed` | The push failed; `push_detail` says why |
| `skipped` | Nothing was pushed, such as in a repo with no remote |

Owned by the code (`src/engine/handlers/fold.ts`).

### `features.state` — feature branch lifecycle

| Value | Source | Meaning |
|---|---|---|
| `open` | tmb | Takes tasks |
| `ready` | tmb | In a repo with no remote, its review passed or was waived; the Human merges it locally |
| `pr_open` | tmb | Its pull request is open; it still takes fix tasks |
| `merged` | GitHub | Its pull request merged, or the local base branch holds its tip; final |
| `closed` | GitHub | Its pull request closed without a merge; a task or a new pull request reopens it |
| `dropped` | tmb | Ended without its work; `drop_reason` says why |

Owned by the code (`src/engine/handlers/common.ts`); no `CHECK`.

### `reviews.verdict` — reviewer verdict

| Value | Source | Meaning |
|---|---|---|
| `pass` | tmb | The commit may go on to its pull request |
| `fail` | tmb | Blocking findings; a truest task goes back to `open` |

Owned by the code (`src/engine/handlers/reviews.ts`). There is no `escalate`. Each entry of `reviews.findings` is `{text, blocking}`.

### `reviews.target_kind` — what a review judged

| Value | Meaning |
|---|---|
| `commit` | One commit |
| `branch` | A branch at its tip |

The engine checks it.

### `runs.outcome` — how a run ended

| Value | Meaning |
|---|---|
| `finished` | The run did what it was started for: a worker's task left `open`, or a reviewer recorded a verdict |
| `stopped` | The run ended any other way, including a reviewer host's session that ended before a verdict |

Owned by the code (`src/engine/host-runs.ts`). NULL while the run is open.

### `check_runs.result` — result of a task's checks

| Value | Meaning |
|---|---|
| `passed` | Every command passed |
| `failed` | A command failed |
| `not_run` | A command could not start, or was not reached after an earlier one did not pass |

Owned by the code (`src/engine/checks.ts`). Each entry of `check_runs.commands` carries the same three values as its `status`.

### `guard_decisions.decision` — the gate's answer

| Value | Meaning |
|---|---|
| `allow` | The event goes through |
| `deny` | The event is refused; `reason` says why |

The engine checks it.

### `guard_decisions.event` — host events

`event` holds JSON whose `type` is one of the host-neutral events below. Every host adapter raises the same ones (`src/engine/decide.ts`).

| Value | Raised when |
|---|---|
| `session-start` | A host session starts |
| `before-file-write` | An agent is about to write a file |
| `before-agent-start` | A subagent is about to start |
| `agent-start-failed` | A subagent's start failed |
| `after-agent-stop` | A subagent stopped |
| `worker-in-folder` | A worker names its task from the folder it works in |
| `before-shell-command` | An agent is about to run a shell command |

The event's `role` is a role above, `main-agent` for the host's main agent, or `unnamed-agent` when the host does not say which agent is starting.

### `review_marks.kind` and `review_marks.state` — review marks

The engine checks both.

A review mark's kind is `pass`, `fail` or `waiver`, and its state on GitHub is `success` or `failure`, under the status check `tmb/review`.

---

## Code graph vocabularies

### `edges.resolution`

| Value | Meaning |
|---|---|
| `exact` | The target symbol was proved |
| `name` | The target was matched by name only |
| `unresolved` | The target could not be linked |

Schema enforces via `CHECK`.

### `concepts.kind` and `concepts.status`

| Column | Value | Meaning |
|---|---|---|
| `kind` | `flow` | A flow through the code |
| `kind` | `rule` | A rule the code keeps |
| `status` | `verified` | Its anchors were found at the last check |
| `status` | `broken` | An anchor is gone; `status_reason` says which |

Schema enforces via `CHECK`.

### `areas.status`

| Value | Meaning |
|---|---|
| `ok` | The area matches files |
| `broken` | The area matches no file |
| `review` | Its size moved by more than a quarter since it was written; the planner looks at it |

Schema enforces via `CHECK`.

### Owned by the code

| Column | Values |
|---|---|
| `layers.layer` | `base`, `task:<id>`, `feature:<id>` |
| `files.lane` | `test`, `product` |
| `dirs.summary_source` | `readme`, `none` |
| `files.summary_source` | `header` (a parsed file), `heading` (a file not parsed), `none` |
| `symbols.kind` | `function`, `method`, `class`, `interface`, `type`, `const`, `sh_function`, `sql_table`, `sql_index`, `sql_trigger`, `module`, `hook`, `runner` |
| `edges.kind` | `calls`, `imports`, `instantiates`, `sources`, `runs`, `reads_table`, `writes_table`, `indexes`, `triggers_on`, `bundles`, `reads_config`, `covers` |
| `misses.lookup` | `graph_map`, `graph_find`, `graph_symbol`, `graph_scope` |

Symbol and edge kinds are the one contract every language of the code graph meets (`src/engine/graph/languages/contract.ts`).

---

## Outside the databases

| Vocabulary | Values | Where |
|---|---|---|
| Channel | `dev`, `rc`, `stable` | `src/program.ts` |
| Operation refusal code | `invalid_input`, `not_found`, `refused` | `src/engine/handlers/errors.ts` |
| Why the record did not open | `missing`, `unreadable`, `newer` | `src/engine/store/open.ts` |
| `tmb doctor` check status | `ok`, `warn`, `fail` | `src/doctor/types.ts` |
| Feedback program setting | `on`, `off` | `src/engine/feedback/setting.ts` |

## How to add a new ENUM value

1. Open a PR that adds the value to the schema or code that consumes it, and to this page.
2. Add a test that covers the new value's path.
3. A value in a `CHECK`, which only the code graph has, needs a new schema step: SQLite cannot change a `CHECK` in place.

---

## Lint guard

Planned: a lint that compares every table on this page with the code in both directions. A value the code uses must be documented, and a documented value must appear in code. The link lint (`tests/lint/links.ts`) checks only this page's links.

---

## Related

- [`LABELS.md`](LABELS.md) — same governance rule for GH issue labels
- [`CONFIG.md`](../architecture/CONFIG.md) — the settings keys
