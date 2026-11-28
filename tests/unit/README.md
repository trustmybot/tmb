# Unit tests

One engine rule at a time, called directly. They run with `bun test` on every pull request ([all layers](../README.md)). A test not listed here says what it proves in its header comment.

## Record and setup

| Test | What it proves |
|---|---|
| [engine/store.test.ts](engine/store.test.ts) | A new or upgraded record is signed with the version and program that wrote its shape; an older tmb refuses a newer record and names them. |
| [cli/setup.test.ts](cli/setup.test.ts) | init ties the project to the program running it, records the tie once, and says when another program's init moves it. init asks only the review mode, on a terminal and when none is chosen, with what each costs, and records that init chose it; with no terminal it asks nothing and says no task starts until the mode is chosen; it stores only the host, its role and that mode, keeps what onboard stored and refuses an unknown role. onboard refuses a project or a host init has not prepared, changes a setting and can be run twice, and asks a host's role, the base branch, the review mode and the checks; with no terminal it never chooses the review mode, and `--review-mode` with `--yes` sets it. |
| [engine/review-mode-gate.test.ts](engine/review-mode-gate.test.ts) | No task starts until the review mode is chosen: with it chosen the task starts in that mode; without it task_start is refused, asking the planner to ask the Human and naming `tmb onboard`, and the planner's settings_set of the Human's answer lets it start; in an unattended run settings_set cannot choose or change the mode, so the task stays refused. The record keeps which way the mode was chosen. |
| [engine/settings-tools.test.ts](engine/settings-tools.test.ts) | settings_get shows the settings, the empty ones and what tmb found; settings_set is the planner's, changes only what it is given and refuses an empty request or a bad value. |
| [engine/session-start.test.ts](engine/session-start.test.ts) | With the settings empty the planner's session start tells it to apply its recommendation, with what tmb found, and to remind the Human of `tmb onboard`, but to ask the Human for the review mode and never set it; an unattended run is told to name the values and to leave the review mode for the Human's `tmb onboard`; only the empty ones are named, and once all are set the section is gone. |
| [adapters/host-refresh.test.ts](adapters/host-refresh.test.ts) | A project wired by one version and opened by another ends with the files a fresh init writes, and one refresh in the record; a second session start changes nothing; the Human's own entries stay; nothing is refreshed while a task is open; a project of another program, or with no record, is left alone; an older program refreshes too; a failed refresh names `tmb init` and records nothing; the session start's one line, attended and unattended; init takes out a tmb hook under an event it no longer uses. |

## Tasks, feature branches and review

| Test | What it proves |
|---|---|
| [engine/feature-branch.test.ts](engine/feature-branch.test.ts) | feature_start, the fold on close, the refusal of a task whose work is already on the feature branch, the close of a task whose earlier fold stopped before it recorded the close, and the backup push. |
| [engine/feature-update.test.ts](engine/feature-update.test.ts) | feature_start cuts from origin's base, fetched first, unless the local base is ahead or origin is out of reach; feature_update merges the base into the feature branch without rewriting it, fast-forwards a branch with no commit of its own, refuses a conflict changing nothing and naming the files, and the brief says whether the tip holds the base and groups no base change under a task. |
| [engine/truest.test.ts](engine/truest.test.ts) | In truest mode a task is cut from the base branch and feature_start is refused; close runs the checks and leaves the task in review with its worktree, folding nothing; a fail reopens the task and a pass covers only the commit it names; only a reviewer run reviews and only the Human waives; task_pr is the planner's and needs a pass or a waiver and an origin; a task keeps the review mode of its start. |
| [engine/pull-request-state.test.ts](engine/pull-request-state.test.ts) | A feature branch in pr_open moves to merged or closed from the pull request's state; a failed read leaves it; the planner's session start names the ones that ended. |
| [engine/linguist/linguist.test.ts](engine/linguist/linguist.test.ts) | Linguist's table marks programming languages (TypeScript, Shell, Dockerfile, Makefile) apart from prose, markup and data (Markdown, HTML, CSS, JSON, YAML, TOML, SQL); a file the table does not know, or a name with no extension it knows, is not refused; an extension of more than one type is refused only when every language left is programming. |

## Guards and hosts

| Test | What it proves |
|---|---|
| [engine/decide.test.ts](engine/decide.test.ts) | The gate records each decision and judges no file write. A run ends finished or stopped. tmb reads no shell command: [adapters/claude-code/hook.test.ts](adapters/claude-code/hook.test.ts) shows a push that skips git's hook is neither refused nor recorded. |
| [engine/human-only.test.ts](engine/human-only.test.ts) | The Human's steps on the command line are both waivers, setting the review mode, `tmb remove` and `tmb purge`, each after a typed yes on a terminal. The guard finds one in an agent's shell command however the program is reached, through a path, `env`, `sh -c` or `eval`, and not in a commit message or a here-document; Claude Code's Bash call is denied with the reason, whatever the role, and the deny is recorded. Any other shell command is allowed and not recorded. |
| [engine/host-roles.test.ts](engine/host-roles.test.ts) | Init gives each host a role, planner by default. A host set up as the reviewer has its main agent briefed and recorded as the reviewer, is told which feature branches wait for a review at their tip, and has a run that opens at its session start, ends with its verdict or with no verdict at its session end, and opens again at its next brief. A review of a feature branch links its run to that branch. |
| [adapters/claude-code/role-files.test.ts](adapters/claude-code/role-files.test.ts) | The worker's Claude Code agent file asks for worktree isolation where the project is a git work tree; the reviewer's never does. |
| [engine/permissions.test.ts](engine/permissions.test.ts) | The permission table: what every role may read, each shipped role's defaults, the Human's fixed steps, the record commands the command line keeps, a role tmb does not ship, and the refusal's words; a project's grants and revokes, who made each, the list that marks them, and the changes refused: a fixed step, reading, the Human's own actions, an unknown action. |
| [adapters/claude-code/skill-files.test.ts](adapters/claude-code/skill-files.test.ts) | init writes each of tmb's skills to the project's `.claude/skills/<name>/SKILL.md`, marked as tmb's; it never touches a skill file tmb did not write, removes its own for a skill this version no longer has, doctor names each one that differs, and `tmb remove` deletes only tmb's. |
| [engine/skills.test.ts](engine/skills.test.ts) | Every file in `skills/` is a listed skill named `tmb-…` with a one-line description, and every skill the planner's role or a skill names exists. |
| [adapters/claude-code/usage.test.ts](adapters/claude-code/usage.test.ts) | A Claude Code transcript gives tokens per model, each message counted once; an unreadable one gives no cost. |

## Code graph

| Test | What it proves |
|---|---|
| [engine/graph/graph.test.ts](engine/graph/graph.test.ts) | Each language is parsed and looked up from the base branch commit, never the working folder; a reference links only on proof; a concept whose code is gone is marked broken and kept; a task's commit is laid on top for its reads and dropped once it closes; misses are recorded. |

Two of the code graph's tests, in [engine/graph/typescript/](engine/graph/typescript/functions.test.ts) with the TypeScript rules' other tests, read a public repo, hono, at a fixed commit: that no function is left out, and that every link between files agrees with the TypeScript compiler.

- The tests never use the network. On a developer's machine run `bun tests/lib/pinned-repo.ts` once to fetch that commit (about 8 MB); until then the two tests are skipped and say so.
- CI fetches it before `bun test`, and there a missing folder or another commit fails.

## Command line

| Test | What it proves |
|---|---|
| [cli/help.test.ts](cli/help.test.ts) | A command at most two typing mistakes away, or one that starts with what was typed, is named; a swap of two neighbouring letters counts as one mistake; every match is named and none when none is close; a hidden command is never named; `upgrade` reaches `update` only through the table of other names. Colour is on for a terminal, off for a pipe, a file, `TERM=dumb` and `NO_COLOR`, on with `FORCE_COLOR`, and `NO_COLOR` wins over it. The short help groups the commands in one column. |
| [engine/feedback.test.ts](engine/feedback.test.ts) | The setting and its channel defaults, the two off switches, the first run's notice and question; a report's fields, cleaned paths and removed secrets; the body for the CLI route and the link for the form route, with a long report shortened; the form read from the repo and the built-in copy; `tmb feedback` and its `on`, `off` and `status`; the planner's two tools and their refusals. Not tested: the two routes against GitHub itself, and the labelling workflow. |
| [scripts/package-managers.test.ts](scripts/package-managers.test.ts) | From a release's `SHA256SUMS`, each channel gets a Homebrew cask, a Scoop manifest and three winget manifests under its own program name, with every platform's file and checksum, no placeholder left, and updates left to tmb. A missing checksum or a version that is not a release's is refused. Only the newest build on a channel counts as current. Publishing skips when the token or the repo is missing, pushes one commit, pushes nothing when the manifests are already there, and keeps the other channels' manifests. Install through a package manager is not supported yet (trustmybot/tmb#91). |
