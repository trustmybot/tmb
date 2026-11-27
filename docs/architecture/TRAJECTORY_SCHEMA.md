# Trajectory schema

The complete schema of the record: every table, column, index and trigger, and the rules the data keeps. What the record is for and the rules it follows are in [TRAJECTORY.md](TRAJECTORY.md).

The record is one SQLite file, `.tmb/trajectory.db`, in the workspace folder and left out of git. Its schema is `src/engine/store/schema.ts`, at `SCHEMA_VERSION = 12` (`PRAGMA user_version`). The code graph has its own file and schema ([CODE_GRAPH.md](CODE_GRAPH.md#schema)); no foreign key crosses between the two.

**This page is the one schema the record is built to.** A table or column marked Planned, with its issue, is not built yet; one marked "goes" is built and will be removed. Everything unmarked is built. A schema change updates this page in the same pull request. Planned: a generator with a freshness test that fails when it drifts.

The record is tmb's cold memory ([`MEMORY.md`](MEMORY.md)): the only source of truth for workflow state. Its tables fall into four groups:

- **Events** — `events`, the one append-only table. Every write to the record is one event; nothing else is the source of truth.
- **Projections** — each row is the current state of one record, folded from its events. They can be emptied and rebuilt from `events`. Built: `issues`, `discussions`, `features`, `tasks`, `runs`, `check_runs`, `reviews`, `guard_decisions`, `waivers`, `review_marks`, `setting_changes`, `freezes`, `feedback_reports`, `imports`. Planned: `sessions`, `pull_requests`, `milestones`, `issue_links`, `docs`.
- **Search** — `search`, one full-text index.
- **Not folded from events** — `meta`, the record's own facts, and `sync_state` (Planned), where each poll of the remote stopped.

```mermaid
flowchart LR
    W["A write"] --> E["events (append-only)"]
    E -->|"same fold, live or rebuild"| P["projections"]
    E -->|"titles and bodies"| S["search"]
    Y["The syncer (Planned)"] -->|"a change on the remote"| W
    Y --> T["sync_state"]
```

## Design requirements

Every table, and every change to one, meets these requirements.

- **Trajectory.** The record exists to keep the trajectory of work. Every table either records a step in it (a fact) or describes something that takes part in it (a dimension). Anything else does not belong in it: a setting's value is in the config, and a choice is never a column.
- **Consistency.** A projection table is plural and its record kind is the singular: `tasks` → `task`, `check_runs` → `check_run`. Every projection row carries its id, `created_by` (the JSON actor of its first event) and `created_at` (that event's time). Ids are ULIDs, never autoincrement.
- **Room to grow.** A new session, host, vendor, role, remote or record kind is new rows, never a reshaped table. The schema checks shape only: valid JSON, a text that is not blank, which columns are set together. Every list of values is checked by the engine ([ENUMS.md](../contributing/ENUMS.md)), so no list of values is a CHECK.
- **Nothing lost for want of a column.** A fact with no column stays in its event's data. A column added later is folded from the events already kept, so the schema can start small.
- **Fits the remote, names no vendor.** A mirrored row keeps the remote's own id, state and words as text. No column or table is named after a vendor, and which remote a row came from is on the row.
- **Local first.** No table needs a remote. Every column that describes the remote is nullable, and a row with no `remote_id` is local.

## Diagram

A solid line is built and a dashed line is Planned. Every foreign key refuses the delete of a row that another row points at (`ON DELETE NO ACTION`), and the record opens with `foreign_keys = ON`.

```mermaid
erDiagram
    issues ||--o{ tasks : "has"
    issues ||--o{ discussions : "has"
    features |o--o{ tasks : "folds in"
    tasks |o--o{ tasks : "replaces"
    tasks |o--o{ runs : "worked by"
    features |o--o{ runs : "reviewed by"
    tasks ||--o{ check_runs : "checked by"
    runs |o--o{ reviews : "wrote"
    features |o--o{ reviews : "judged"
    tasks |o..o{ reviews : "judged"
    reviews |o..o{ reviews : "carried from"
    milestones |o..o{ issues : "groups"
    issues ||..o{ issue_links : "from"
    issues ||..o{ issue_links : "to"
    pull_requests |o..o{ discussions : "has"
    features |o..o{ pull_requests : "carried by"
    tasks |o..o{ pull_requests : "carried by"
    sessions |o..o{ sessions : "started"
    sessions ||..o{ runs : "started"
    sessions |o..o{ tasks : "started"
    sessions |o..o{ guard_decisions : "asked in"
    runs |o..o{ runs : "resumed from"
    runs |o..o{ guard_decisions : "about"
    docs |o..o{ tasks : "implemented by"
    tasks |o--o{ waivers : "waived"
    features |o--o{ waivers : "waived"
    features |o--o{ review_marks : "marked"
    tasks |o--o{ review_marks : "marked"
    waivers |o--o{ waivers : "carried from"
    sessions |o..o{ freezes : "asked in"
    issues |o--o{ feedback_reports : "filed as"
```

## Tables

In each table an empty last cell means built.

### `events`

| Column | Type | Null | Holds and constraints | Planned |
|---|---|---|---|---|
| `id` | TEXT | PK | A ULID |  |
| `record_kind` | TEXT | NOT NULL | One of `issue`, `discussion`, `task`, `run`, `check_run`, `review`, `guard_decision`, `feature`, `waiver`, `review_mark`, `setting_change`, `freeze`, `feedback_report`, `import`, checked by the engine | Gains one kind per planned projection. Old `audit` events stay and the fold skips them |
| `record_id` | TEXT | NOT NULL |  |  |
| `type` | TEXT | NOT NULL | `created` or `updated` |  |
| `data` | TEXT | NOT NULL | CHECK `json_valid(data)` |  |
| `actor_kind` | TEXT | NOT NULL | `human`, `agent`, or `tmb` for a write no person or agent made |  |
| `actor_role` | TEXT | nullable | `planner`, `worker` or `reviewer`, checked by the engine, so a role a project creates is a new value |  |
| `actor_host` | TEXT | nullable |  |  |
| `actor_source` | TEXT | nullable | Which part of tmb wrote it: `syncer` or `upgrade`. Set only for a `tmb` actor |  |
| `actor_session` | TEXT | nullable | The session that acted. NULL for the Human at a terminal and for tmb | trustmybot/tmb#63 |
| `actor_remote` | TEXT | nullable | On an event the syncer wrote, the remote account that made the change | trustmybot/tmb#70 |
| `at` | TEXT | NOT NULL |  |  |

Table constraint: a `human` actor has no role and no host; an `agent` actor has both; a `tmb` actor has no role and no host, and has a source. A NULL host on an agent, or a NULL source on tmb, is refused.

- **Example.** An upgrade moves a fact to a new record. It writes the event as `tmb`, source `upgrade`.
- **Example, Planned.** A pull request is merged in the browser. The syncer writes one `updated` event: actor `tmb`, source `syncer`, `actor_remote` the account that merged it.
- **Edge case.** A write with an unknown record kind or role is still refused, by the engine.
- **Edge case.** A tool call or a hook names itself as tmb. The engine refuses it: only the engine's own code writes as tmb. A push hook that names tmb is taken as the Human's.

### `issues`

| Column | Type | Null | Holds and constraints | Planned |
|---|---|---|---|---|
| `id` | TEXT | PK |  |  |
| `title` | TEXT | NOT NULL | CHECK `length(trim(title)) > 0` |  |
| `body` | TEXT | NOT NULL | Default `''` |  |
| `state` | TEXT | NOT NULL | Default `'open'`. `open` or `closed` |  |
| `state_reason` | TEXT | nullable | Why it closed, in the remote's words, such as completed, not planned or duplicate | trustmybot/tmb#70 |
| `milestone` | TEXT | nullable | The milestone's name | Goes, for `milestone_id` (trustmybot/tmb#70) |
| `milestone_id` | TEXT | nullable | FK → `milestones.id` | trustmybot/tmb#70 |
| `priority` | TEXT | nullable | `urgent`, `high`, `medium` or `low`. A remote's value outside the list is kept as it is and ordered last | trustmybot/tmb#402 |
| `type` | TEXT | nullable | The kind of work, such as bug or feature | trustmybot/tmb#402 |
| `labels` | TEXT | NOT NULL | A JSON list of free labels. Default `'[]'` | trustmybot/tmb#402 |
| `assignees` | TEXT | NOT NULL | A JSON list of remote accounts. Default `'[]'` | trustmybot/tmb#409 |
| `repo` | TEXT | nullable | The repo it belongs to, named as `tasks.repo` names its own | trustmybot/tmb#402 |
| `remote_url` | TEXT | nullable | Its address on the remote. UNIQUE | trustmybot/tmb#402 |
| `remote`, `remote_id`, `remote_updated_at`, `remote_gone_at` | TEXT | nullable | [The remote columns](#the-remote-columns). All NULL for a local issue | trustmybot/tmb#70 |
| `created_by` | TEXT | NOT NULL |  |  |
| `created_at` | TEXT | NOT NULL |  |  |
| `updated_at` | TEXT | NOT NULL |  |  |

- **Example.** The Human publishes a local issue. Its `remote_id` and `remote_url` are filled, and from then on the syncer follows it.
- **Edge case.** The repo's issues are kept in another repository. `remote_url` names that one and `repo` still names the code's.

### `issue_links`

Planned (trustmybot/tmb#402). One row per link between two issues. Record kind `issue_link`.

| Column | Type | Null | Holds and constraints |
|---|---|---|---|
| `id` | TEXT | PK |  |
| `issue_id` | TEXT | NOT NULL | FK → `issues.id`. The issue the link is on |
| `kind` | TEXT | NOT NULL | `parent`, `blocked_by` or `duplicate_of` |
| `target_id` | TEXT | NOT NULL | FK → `issues.id`. UNIQUE with `issue_id` and `kind` |
| `removed_at` | TEXT | nullable | A removed link keeps its row |
| `created_by`, `created_at` | TEXT | NOT NULL |  |

- **Example.** Issue B is blocked by issue A. While A is open, the planner is shown B as blocked.
- **Edge case.** An issue links to itself, or two issues block each other. The engine refuses the write.

### `milestones`

Planned (trustmybot/tmb#70). One row per milestone. Record kind `milestone`.

| Column | Type | Null | Holds and constraints |
|---|---|---|---|
| `id` | TEXT | PK |  |
| `title` | TEXT | NOT NULL | UNIQUE with `repo` |
| `description` | TEXT | NOT NULL | Default `''` |
| `state` | TEXT | NOT NULL | `open` or `closed` |
| `repo` | TEXT | nullable | Named as `tasks.repo` names its own |
| `remote`, `remote_id`, `remote_updated_at`, `remote_gone_at` | TEXT | nullable | [The remote columns](#the-remote-columns) |
| `created_by`, `created_at`, `updated_at` | TEXT | NOT NULL |  |

- **No due date.** The record holds no schedule.
- **Edge case.** An upgrade finds issues that name a milestone by text. It makes one row per name and repo and points each issue at it.

### `discussions`

| Column | Type | Null | Holds and constraints | Planned |
|---|---|---|---|---|
| `id` | TEXT | PK |  |  |
| `issue_id` | TEXT | NOT NULL | FK → `issues.id` | Becomes nullable: exactly one of `issue_id` and `pull_request_id` is set (trustmybot/tmb#411) |
| `pull_request_id` | TEXT | nullable | FK → `pull_requests.id` | trustmybot/tmb#411 |
| `kind` | TEXT | NOT NULL | `note` or `decision` | Gains `comment`, for one mirrored from the remote (trustmybot/tmb#70) |
| `body` | TEXT | NOT NULL | CHECK `length(trim(body)) > 0`. A note and a decision never change | A comment's body follows the remote's (trustmybot/tmb#70) |
| `remote_author` | TEXT | nullable | The remote account that wrote a comment | trustmybot/tmb#70 |
| `remote`, `remote_id`, `remote_updated_at`, `remote_gone_at` | TEXT | nullable | [The remote columns](#the-remote-columns). All NULL for a note and a decision that was not published | trustmybot/tmb#70 |
| `created_by` | TEXT | NOT NULL |  |  |
| `created_at` | TEXT | NOT NULL |  |  |
| `updated_at` | TEXT | nullable | When a comment last changed | trustmybot/tmb#70 |

- **Example.** A comment is edited on the remote. The row's body follows it, and each version stays in `events`.
- **Edge case.** A decision is local even on a mirrored issue. The syncer never sends it, and never changes it.

### `pull_requests`

Planned (trustmybot/tmb#405, trustmybot/tmb#411). One row per pull request. Record kind `pull_request`.

| Column | Type | Null | Holds and constraints |
|---|---|---|---|
| `id` | TEXT | PK |  |
| `url` | TEXT | NOT NULL | UNIQUE |
| `repo` | TEXT | nullable | Named as `tasks.repo` names its own |
| `feature_id` | TEXT | nullable | FK → `features.id` |
| `task_id` | TEXT | nullable | FK → `tasks.id`. At most one of `feature_id` and `task_id` is set; a teammate's pull request has neither |
| `author` | TEXT | nullable | The remote account that opened it. NULL when tmb opened it |
| `closes` | TEXT | NOT NULL | A JSON list of the issues it closes. Default `'[]'` |
| `base_remote`, `head_remote` | TEXT | nullable | The remote repository it merges into, and the one its branch is in. They differ for a fork |
| `state` | TEXT | NOT NULL | `open`, `merged` or `closed` |
| `draft` | INTEGER | NOT NULL | 1 while it is a draft. Default 0 |
| `head_commit` | TEXT | nullable | The commit at its tip when last seen |
| `review_decision`, `checks` | TEXT | nullable | The remote's review decision and the result of its checks, when last seen |
| `remote`, `remote_id`, `remote_updated_at`, `remote_gone_at` | TEXT | nullable | [The remote columns](#the-remote-columns) |
| `created_by`, `created_at`, `updated_at` | TEXT | NOT NULL |  |

- **Example.** tmb opens a pull request: a row made by the planner. The Human merges it in the browser: an update made by tmb, from the syncer.
- **Edge case.** A contributor opens a pull request from their fork. The row has their account as `author`, their fork as `head_remote`, and no task.

### `features`

| Column | Type | Null | Holds and constraints | Planned |
|---|---|---|---|---|
| `id` | TEXT | PK |  |  |
| `name` | TEXT | NOT NULL | UNIQUE; CHECK `length(trim(name)) > 0` |  |
| `base_branch` | TEXT | NOT NULL |  |  |
| `base_commit` | TEXT | NOT NULL | The commit the branch was cut from. It never changes |  |
| `base_merged_commit` | TEXT | nullable | The base branch's commit last brought into the branch |  |
| `state` | TEXT | NOT NULL | Default `'open'` |  |
| `repo` | TEXT | nullable | NULL is the project folder itself |  |
| `drop_reason` | TEXT | nullable |  |  |
| `pr_url` | TEXT | nullable |  | Goes, for a `pull_requests` row (trustmybot/tmb#405) |
| `created_by` | TEXT | NOT NULL |  |  |
| `created_at` | TEXT | NOT NULL |  |  |
| `updated_at` | TEXT | NOT NULL |  |  |

### `tasks`

| Column | Type | Null | Holds and constraints | Planned |
|---|---|---|---|---|
| `id` | TEXT | PK |  |  |
| `issue_id` | TEXT | NOT NULL | FK → `issues.id`. No task lives without an issue |  |
| `feature_id` | TEXT | nullable | FK → `features.id` |  |
| `replaces` | TEXT | nullable | FK → `tasks.id`. The dropped task it replaces |  |
| `session_id` | TEXT | nullable | FK → `sessions.id`. The session that started it | trustmybot/tmb#63 |
| `doc_id` | TEXT | nullable | FK → `docs.id`. The design it implements | trustmybot/tmb#302 |
| `title` | TEXT | NOT NULL | CHECK `length(trim(title)) > 0` |  |
| `spec` | TEXT | NOT NULL | Default `''` |  |
| `state` | TEXT | NOT NULL |  |  |
| `kind` | TEXT | nullable |  |  |
| `review_mode` | TEXT | nullable |  |  |
| `repo` | TEXT | nullable | NULL is the project folder itself |  |
| `branch` | TEXT | nullable |  |  |
| `worktree` | TEXT | nullable |  |  |
| `base_commit` | TEXT | nullable |  |  |
| `commit_sha` | TEXT | nullable |  |  |
| `main_snapshot` | TEXT | nullable |  |  |
| `push_result` | TEXT | nullable |  |  |
| `push_detail` | TEXT | nullable |  |  |
| `drop_reason` | TEXT | nullable |  |  |
| `pr_url` | TEXT | nullable |  | Goes, for a `pull_requests` row (trustmybot/tmb#405) |
| `created_by` | TEXT | NOT NULL |  |  |
| `created_at` | TEXT | NOT NULL |  |  |
| `updated_at` | TEXT | NOT NULL |  |  |

### `sessions`

Planned (trustmybot/tmb#63, trustmybot/tmb#254). One row per host session. Record kind `session`.

| Column | Type | Null | Holds and constraints |
|---|---|---|---|
| `id` | TEXT | PK | A ULID, stable across a compaction, a clear and a resume |
| `host` | TEXT | NOT NULL | The host's id |
| `host_session_id` | TEXT | NOT NULL | The host's own id for the session, an opaque text. UNIQUE with `host` |
| `role` | TEXT | NOT NULL | The role the host's main agent took |
| `parent_id` | TEXT | nullable | FK → `sessions.id`. The session that started this one |
| `started_at` | TEXT | NOT NULL |  |
| `ended_at` | TEXT | nullable | NULL while active. A resume clears it |
| `cost` | TEXT | nullable | Tokens per model, the session's own, without its runs' |
| `tmb_version` | TEXT | NOT NULL | The tmb program that served it |
| `created_by`, `created_at`, `updated_at` | TEXT | NOT NULL |  |

- **Example.** One session plans and a second session reviews. That is two rows with two roles, in one record.
- **Edge case.** A planner starts another planner. The second row names the first in `parent_id`.
- **No lanes table.** A lane is a session; what it holds is the tasks and runs that name it.

### `runs`

| Column | Type | Null | Holds and constraints | Planned |
|---|---|---|---|---|
| `id` | TEXT | PK |  |  |
| `task_id` | TEXT | nullable | FK → `tasks.id` |  |
| `feature_id` | TEXT | nullable | FK → `features.id`, for a branch review |  |
| `session_id` | TEXT | nullable | FK → `sessions.id`. The session that started the run. NULL only on a run older than the session record | trustmybot/tmb#63 |
| `resumed_from` | TEXT | nullable | FK → `runs.id` | trustmybot/tmb#256 |
| `role` | TEXT | NOT NULL | `planner`, `worker` or `reviewer`, checked by the engine |  |
| `host` | TEXT | nullable | The host that ran the agent. It can differ from the host of the session that started it | trustmybot/tmb#256 |
| `model`, `runner` | TEXT | nullable | The model that ran, and the name of the configured agent that ran it. Which agent serves which role is a setting; which one ran is a fact of the run | trustmybot/tmb#411 |
| `effort` | TEXT | nullable | The effort it was given | trustmybot/tmb#256 |
| `started_at` | TEXT | NOT NULL |  |  |
| `ended_at` | TEXT | nullable |  |  |
| `outcome` | TEXT | nullable | `finished` or `stopped` |  |
| `stop_cause` | TEXT | nullable | Set only on a stopped run: `failed`, `out_of_turns`, `killed`, `escalated`, `stuck` or `not_started` | trustmybot/tmb#256 |
| `stop_detail` | TEXT | nullable | The cause in words | trustmybot/tmb#256 |
| `cost` | TEXT | nullable | Tokens per model. CHECK `cost IS NULL OR json_valid(cost)` |  |
| `usage_source` | TEXT | nullable | Where the token count came from, "not measured" included | trustmybot/tmb#256 |
| `tool_calls` | INTEGER | nullable | Its number of tool calls | trustmybot/tmb#256 |
| `tools` | TEXT | nullable | JSON: per tool, the calls and result sizes | trustmybot/tmb#256 |
| `tmb_version` | TEXT | nullable | The tmb program that served it | trustmybot/tmb#406 |
| `created_by` | TEXT | NOT NULL |  |  |
| `created_at` | TEXT | NOT NULL |  |  |

- **Example.** The planner's session is on one vendor's host and the worker runs on a local model. The run's `host`, `model` and `runner` say so; the session's row does not change.

### `check_runs`

| Column | Type | Null | Holds and constraints | Planned |
|---|---|---|---|---|
| `id` | TEXT | PK |  |  |
| `task_id` | TEXT | NOT NULL | FK → `tasks.id` |  |
| `commit_sha` | TEXT | NOT NULL |  |  |
| `commands` | TEXT | NOT NULL | Each command and its result. Default `'[]'`; CHECK `json_valid(commands)` |  |
| `started_at` | TEXT | NOT NULL |  |  |
| `ended_at` | TEXT | nullable |  |  |
| `result` | TEXT | nullable |  |  |
| `created_by` | TEXT | NOT NULL |  |  |
| `created_at` | TEXT | NOT NULL |  |  |

### `reviews`

| Column | Type | Null | Holds and constraints | Planned |
|---|---|---|---|---|
| `id` | TEXT | PK |  |  |
| `run_id` | TEXT | nullable | FK → `runs.id`. The run that wrote it |  |
| `feature_id` | TEXT | nullable | FK → `features.id` | Exactly one of `feature_id` and `task_id` is set (trustmybot/tmb#406) |
| `task_id` | TEXT | nullable | FK → `tasks.id`, for a review of one task | trustmybot/tmb#406 |
| `carried_from` | TEXT | nullable | FK → `reviews.id`. The review a rebase carried over |  |
| `commit_sha` | TEXT | nullable | The commit it judged | Becomes NOT NULL (trustmybot/tmb#406) |
| `verdict` | TEXT | NOT NULL |  |  |
| `findings` | TEXT | NOT NULL | Default `'[]'`; CHECK `json_valid(findings)` |  |
| `target_kind` | TEXT | NOT NULL | `commit` or `branch` | Goes (trustmybot/tmb#406) |
| `target` | TEXT | NOT NULL | A name or a SHA, as text | Goes (trustmybot/tmb#406) |
| `created_by` | TEXT | NOT NULL |  |  |
| `created_at` | TEXT | NOT NULL |  |  |

- **Edge case.** A rebase leaves a task's patch unchanged. The pass is carried as a new row for the rebased commit, with the same verdict and findings, naming the newest review of the old commit.

### `guard_decisions`

| Column | Type | Null | Holds and constraints | Planned |
|---|---|---|---|---|
| `id` | TEXT | PK |  |  |
| `event` | TEXT | NOT NULL |  |  |
| `decision` | TEXT | NOT NULL | `allow` or `deny` |  |
| `reason` | TEXT | NOT NULL |  |  |
| `session_id` | TEXT | nullable | FK → `sessions.id` | trustmybot/tmb#406 |
| `run_id` | TEXT | nullable | FK → `runs.id` | trustmybot/tmb#406 |
| `created_by` | TEXT | NOT NULL |  |  |
| `created_at` | TEXT | NOT NULL |  |  |

- **Example.** "Why did this worker never start?" is one lookup: the guard decisions of its session.
- **Edge case.** A push typed by hand has no session and no run. Its guard decision names neither.

### The six tables for single kinds of entry

**Each kind of entry is its own record, with its own columns.** There is no catch-all table.

- **Example 1.** The Human waives a branch's review. The gate finds one `waivers` row for that branch and commit; it parses no text.
- **Example 2.** A setting changes. One `setting_changes` row says who changed it, from what and to what.
- **Edge case.** A record made before these tables kept every such entry in one catch-all table. The upgrade writes each old entry again as an event of its new kind, made by tmb. The old events are never rewritten, and no entry is lost.
- **Edge case.** An old entry on how a review mode was chosen has no setting change beside it. It becomes its own row for the key `review_mode`, with no values.
- **Edge case.** tmb moved to a new program. That alone changes no value: its row repeats the tie in force, and the wiring refresh that follows writes the new tie.
- **Edge case.** An old review mark names a commit that no review and no waiver covers, so its parent cannot be found. It gets no row; its old event stays in `events`.
- **Edge case.** An old entry holds a detail that has no column, such as a feedback report's title. The new event's data keeps it; the row takes only its columns.
- **Edge case.** The config file is not built yet (trustmybot/tmb#305). Until it is, the newest `setting_changes` row for a key is the value in force.

| An entry for | Is |
|---|---|
| A Human waiver, of a task or a feature branch | A `waivers` row |
| A review mark sent to the remote, and a mark sent late | A `review_marks` row |
| A review carried over a rebase | A `reviews` row with `carried_from`, or a `waivers` row with `carried_from` when a waiver covered the old commit |
| A setting change | A `setting_changes` row for its key |
| How a review mode was chosen | The `how` of that review mode's `setting_changes` row |
| Which tmb program the project is tied to, tmb moved, and tmb's wiring redone after an update | A `setting_changes` row with the key `program`. Each holds the whole tie, so the newest row is the tie in force |
| A base branch brought into a feature branch | An `updated` event on the feature branch, which sets `base_merged_commit` |
| A freeze of every session's work, and its lifting | A `freezes` row. The table is built; freezing is Planned (trustmybot/tmb#64) |
| A feedback report filed or its form opened | A `feedback_reports` row |
| A migration from the plugin | An `imports` row |

Each of the six tables also has `id` (PK), `created_by` and `created_at`. Each is a projection, and its record kind is its name in the singular.

| Table | Column | Type | Null | Holds and constraints |
|---|---|---|---|---|
| `waivers` | `task_id` | TEXT | nullable | FK → `tasks.id` |
| | `feature_id` | TEXT | nullable | FK → `features.id`. Exactly one of the two is set |
| | `commit_sha` | TEXT | NOT NULL | The commit the waiver covers |
| | `reason` | TEXT | NOT NULL | Only the Human writes a waiver |
| | `carried_from` | TEXT | nullable | FK → `waivers.id`. The Human's waiver that a rebase carried to this commit, with its reason |
| `review_marks` | `task_id` | TEXT | nullable | FK → `tasks.id`, for a mark on one task's commit |
| | `feature_id` | TEXT | nullable | FK → `features.id`. Exactly one of the two is set |
| | `commit_sha` | TEXT | NOT NULL |  |
| | `kind` | TEXT | NOT NULL | `pass`, `fail` or `waiver` |
| | `state` | TEXT | NOT NULL | What the remote is told: `success` or `failure` |
| | `sent_at` | TEXT | nullable | NULL until the remote has it |
| `setting_changes` | `key` | TEXT | NOT NULL |  |
| | `repo` | TEXT | nullable | For one repo's own setting |
| | `old_value`, `new_value` | TEXT | nullable | JSON |
| | `how` | TEXT | nullable | The way the Human chose a review mode: `init`, `onboard` or `planner`. NULL for every other key |
| `freezes` | `reason` | TEXT | NOT NULL | Only the Human's request writes a freeze |
| | `session_id` | TEXT | nullable | FK → `sessions.id`. The session it was asked in |
| | `lifted_by` | TEXT | nullable | The JSON actor that lifted it |
| | `lifted_at` | TEXT | nullable | NULL while frozen |
| `feedback_reports` | `route` | TEXT | NOT NULL | How it was sent |
| | `url` | TEXT | nullable | Where it landed |
| | `issue_id` | TEXT | nullable | FK → `issues.id` |
| `imports` | `source` | TEXT | NOT NULL | What was imported from, such as the plugin |
| | `repo` | TEXT | nullable |  |
| | `detail` | TEXT | NOT NULL | JSON: what was carried and what was left behind |

### `docs`

Planned (trustmybot/tmb#302). One row per design document, so the planner finds the design whether it lives in the repo, outside it such as on a wiki, or in the record itself. Record kind `doc`.

| Column | Type | Null | Holds and constraints |
|---|---|---|---|
| `id` | TEXT | PK |  |
| `repo` | TEXT | nullable | The repo the document describes; NULL is the project folder itself |
| `location` | TEXT | NOT NULL | A path inside the repo, a link outside it, or a name for a document kept in the record. UNIQUE with `repo`; CHECK `length(trim(location)) > 0` |
| `body` | TEXT | nullable | The document's text, only for a document kept in the record |
| `title` | TEXT | NOT NULL | CHECK `length(trim(title)) > 0` |
| `purpose` | TEXT | NOT NULL | What the document is for and when to read it. CHECK `length(trim(purpose)) > 0` |
| `state` | TEXT | NOT NULL | `current` or `retired`. Default `'current'`. A retired row is kept |
| `created_by`, `created_at`, `updated_at` | TEXT | NOT NULL |  |

- **A document lives in one place.** One in the repo or outside it stays there, and the row says where that is and what it is for. One kept in the record has its text in `body`, for a project that keeps no docs in its code.
- **The planner records and updates it;** the Human may. An updated event may change `location`, `body`, `title`, `purpose` and `state`.
- **A task's spec names a row** as the design it implements ([`3_TASKS.md`](../flows/3_TASKS.md)).

### `sync_state`

Planned (trustmybot/tmb#70). One row per remote repository and list. It is not folded from events: a poll that finds nothing writes no event. A lost row costs one full pass.

| Column | Type | Null | Holds and constraints |
|---|---|---|---|
| `remote` | TEXT | NOT NULL | The remote repository. PK with `list`. A fork has two remotes, so two sets of rows |
| `list` | TEXT | NOT NULL | Issues, comments, review comments, pull requests or milestones |
| `tag` | TEXT | nullable | The tag the remote gave last time, sent back to ask "has anything changed?" |
| `since` | TEXT | nullable | The time the next "what changed?" asks from |
| `resume` | TEXT | nullable | Where a read that was cut short stopped, as the remote's reader gave it. The next read goes on from there. NULL after a complete read |
| `synced_at`, `full_pass_at` | TEXT | nullable | When the last poll and the last full pass ended, so a reader knows how old the copy is |
| `wait_until` | TEXT | nullable | Set when the remote asks for a wait. No poll runs before it |
| `claimed_by`, `claim_until` | TEXT | nullable | The short claim one syncer holds, which runs out by itself |
| `last_error` | TEXT | nullable | Why the last poll failed. NULL after a good one |

- **Example.** A first read of a large repo is cut short. The row keeps where the read stopped, and the next read goes on from there. It never starts over.
- **Edge case.** Milestones are few and come in no order of change. Every read lists them all, and no tag is kept.
- **Edge case.** The remote cannot be read at all. `last_error` says why, and the project works as local. The reasons are told apart, because the fix differs: the host is not GitHub, the `gh` program is missing, no one is signed in, there is no network, or the remote asked for a wait.

### `meta`

| Column | Type | Null | Holds and constraints |
|---|---|---|---|
| `key` | TEXT | PK |  |
| `value` | TEXT | NOT NULL | CHECK `json_valid(value)` |

## The remote columns

Planned (trustmybot/tmb#70). **Every record the remote also holds carries the remote's own id.** The four mirrored tables are `issues`, `discussions`, `pull_requests` and `milestones`.

| Column | Holds |
|---|---|
| `remote` | The remote repository the row is mirrored from, named as `sync_state` names it. For a fork it is the upstream |
| `remote_id` | The remote's own id for the item, which a rename does not change. UNIQUE with `remote`. NULL for a local row, which the syncer leaves alone |
| `remote_updated_at` | The remote's time of last change, so an unchanged item is skipped |
| `remote_gone_at` | When the syncer found it deleted or out of reach. NULL while it is there |

- **Example 1.** An issue is closed in the browser. The syncer finds its row by `remote_id` and writes one `updated` event, made by tmb, naming the account that closed it.
- **Example 2.** Nothing changed since the last poll. The syncer sends back the tag it kept in `sync_state`, the remote answers "not modified", and no event is written.
- **Example 3.** A comment names its issue or pull request by number, not by id. The syncer finds the parent row by its remote and number.
- **Example 4.** A list answer leaves out the priority, the links between issues, what a pull request closes, and its review decision and checks. The syncer asks for these in one batched ask, only for the items a list showed as changed.
- **Edge case.** An issue is transferred to another repo. Where the remote keeps its id, the row is kept and its `remote` and address updated. Where it does not, the old row is marked gone and the new one links to it as a duplicate.
- **Edge case.** An issue is deleted on the remote. The full pass sets `remote_gone_at`; the row and its history stay.

## What the record takes from a GitHub issue

| On GitHub | In the record | Why |
|---|---|---|
| Priority, a built-in field | `issues.priority`, the same four values | The planner orders work by it. On the remote it is the field, not a label (trustmybot/tmb#403) |
| Type | `issues.type` | One fact per issue, so a column. On the remote it is GitHub's issue type, not a `type/` label (trustmybot/tmb#403) |
| Labels | `issues.labels` | Free words a project chooses. The project's list of them is a setting, not in the record ([ISSUES.md](ISSUES.md#the-list-is-a-setting)) |
| Milestone | A `milestones` row, named by `issues.milestone_id` | The syncer mirrors its state, and a misspelt name cannot make a second one |
| Relationships: parent, blocked by, duplicate | `issue_links` | The order of work depends on them |
| Assignees | `issues.assignees` | On a shared repo the planner does not take work assigned to someone else |
| Projects | Left out | A board is a view, and the dashboard is tmb's |
| Status, effort, start and target dates | Left out | State comes from tasks, effort belongs to a run, and the record holds no schedule |
| "Relates to" | Left out | It changes no order of work |

## Proposed and left out

Each is a table the plugin had or a split that was weighed.

| Not added | Why |
|---|---|
| A table per review finding | A finding has no state of its own; the next review judges the next commit |
| A table for handoffs between sessions | The record is the handoff |
| A table of people | An account on the remote stays text on the row it acts on. Which account is the user's is a setting ([CONFIG.md](CONFIG.md)) |
| A table of remotes | A remote is text on the rows that name it. Which one issues come from is a setting |
| A table for agents a project creates | Creating one is an event, and its file is the host's ([ROLES.md](ROLES.md#agents-a-project-creates)) |
| A lanes table | A lane is a session |

## Search

One FTS5 virtual table.

| Index | Indexed columns | Unindexed columns | Tokenizer |
|---|---|---|---|
| `search` | `title`, `body` | `record_kind`, `record_id`, `issue_id` | `porter unicode61 remove_diacritics 2` |

It covers issues and discussions. Planned: a task's title and spec (trustmybot/tmb#406), a doc's title, purpose and body (trustmybot/tmb#302), and a mirrored comment like any discussion (trustmybot/tmb#70). There are no embedding tables: search is ranked word search plus the code graph.

## Indexes

| Index | Table | Columns | Unique |
|---|---|---|---|
| `idx_events_record` | `events` | `record_id, id` | no |
| `idx_issues_state` | `issues` | `state, id` | no |
| `idx_discussions_issue` | `discussions` | `issue_id, kind, id` | no |
| `idx_features_state` | `features` | `state, id` | no |
| `idx_tasks_feature` | `tasks` | `feature_id, id` | no |
| `idx_tasks_state` | `tasks` | `state, id` | no |
| `idx_tasks_issue` | `tasks` | `issue_id, id` | no |
| `idx_runs_feature` | `runs` | `feature_id, id` | no |
| `idx_runs_open` | `runs` | `role, ended_at, id` | no |
| `idx_runs_task` | `runs` | `task_id, id` | no |
| `idx_check_runs_task` | `check_runs` | `task_id, id` | no |
| `idx_reviews_feature` | `reviews` | `feature_id, id` | no |

Planned, with each table above: one index per new foreign key column, in the same shape (the column, then `id`), and the unique indexes its table names.

## Triggers

| Trigger | Table | Does |
|---|---|---|
| `events_no_update` | `events` | Refuses every UPDATE: events are append-only |
| `events_no_delete` | `events` | Refuses every DELETE: events are append-only |

## How the groups connect

- Every task belongs to one issue. A task may also belong to a feature branch, and may name the dropped task it replaces.
- A discussion belongs to one issue. Planned: or to one pull request.
- A run links to what it worked on: a task, or a feature branch for a branch review. A review names the commit it judged, the run that wrote it, and its feature branch. Planned: or its task.
- A feature branch and a task record the repo they were cut in; NULL is the project folder itself.
- Settings are not a table of values: each change to a setting is a `setting_changes` row, and the newest row that sets a value is the value in force ([`CONFIG.md`](CONFIG.md)). Planned (trustmybot/tmb#305): the values move to a config file, and the record keeps only the trail.
- A few references are soft: `reviews.target`, `tasks.branch`, every commit column and every remote account hold a name or a SHA with no declared foreign key.

## Rules the data keeps

- **Events are append-only.** Two triggers refuse any UPDATE or DELETE on `events`.
- **Current state is a fold.** The live write path and the rebuild apply the same function to each event, so a rebuilt projection matches the live one.
- **Two event types.** An event is `created` or `updated`. Each record kind lists the columns a created event fills and the columns an updated event may change; `discussions`, `reviews`, `guard_decisions`, `waivers`, `setting_changes`, `feedback_reports` and `imports` rows never change. Planned: a mirrored comment is the one discussion that may.
- **Every write has an actor.** The Human, or an agent named by its role and host. A human actor carries no role or host; an agent actor carries both. Or tmb, named by its source.
- **The remote is the truth for what it holds.** Planned (trustmybot/tmb#70). A mirrored row changes only by an event the syncer wrote, or by a write tmb first made on the remote at the Human's word.
- **Verdicts are append-only.** A new review adds a row. A review names the exact commit it judged, so a later commit is never taken as reviewed.
- **Checks are recorded, not re-run.** Each run of a task's checks is a `check_runs` row with each command it ran and the commit it ran at.
- **Cost is metered, not stored as totals.** A run's `cost` holds the tokens it used per model, filled when the run ends.
- **Nothing is dropped silently.** A dropped task or feature branch keeps its row and its `drop_reason`.
- **Roles are enforced by the engine, not the schema.** Each operation checks which role may call it ([`ROLES.md`](ROLES.md)).

## Schema migration policy

The record's schema is a list of steps, one per version; step *i* takes a database from version *i* to *i + 1*, so a new database and an upgraded one end with the same tables. On open, every missing step runs in one transaction, so the file is never left between versions, and the shape is signed in `meta` with the version and program that wrote it. A record a newer tmb reshaped is refused, never downgraded, and the refusal names the program that wrote it.

- **Example.** A step removes a column. It moves the column's values to their new place in the same step, so no fact is lost.
- **Edge case.** A step changes a projection only. The projection is rebuilt from `events`, which the step never rewrites.

```mermaid
flowchart TD
    O["Open the record"] --> V{"Stored version?"}
    V -->|"older"| U["Run the missing steps in one transaction"]
    U --> S["Sign the shape in meta"]
    V -->|"same"| R["Ready"]
    S --> R
    V -->|"newer"| X["Refuse, name the tmb that wrote it"]
```
