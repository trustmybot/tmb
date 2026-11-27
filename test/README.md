# Unit tests

One engine rule at a time, called directly. They run with `bun test` on every pull request ([all layers](../tests/README.md)). A test not listed here says what it proves in its header comment.

## Record and setup

| Test | What it proves |
|---|---|
| [store.test.ts](store.test.ts) | A new or upgraded record is signed with the version and program that wrote its shape; an older tmb refuses a newer record and names them. |
| [setup.test.ts](setup.test.ts) | init ties the project to the program running it, records the tie once, and says when another program's init moves it. init asks only the review mode, on a terminal and when none is chosen, with what each costs, and records that init chose it; with no terminal it asks nothing and says no task starts until the mode is chosen; it stores only the host, its role and that mode, keeps what onboard stored and refuses an unknown role. onboard refuses a project or a host init has not prepared, changes a setting and can be run twice, and asks a host's role, the base branch, the review mode and the checks; with no terminal it never chooses the review mode, and `--review-mode` with `--yes` sets it. |
| [review-mode-gate.test.ts](review-mode-gate.test.ts) | No task starts until the review mode is chosen: with it chosen the task starts in that mode; without it task_start is refused, asking the planner to ask the Human and naming `tmb onboard`, and the planner's settings_set of the Human's answer lets it start; in an unattended run settings_set cannot choose or change the mode, so the task stays refused. The record keeps which way the mode was chosen. |
| [settings-tools.test.ts](settings-tools.test.ts) | settings_get shows the settings, the empty ones and what tmb found; settings_set is the planner's, changes only what it is given and refuses an empty request or a bad value. |
| [session-start.test.ts](session-start.test.ts) | With the settings empty the planner's session start tells it to apply its recommendation, with what tmb found, and to remind the Human of `tmb onboard`, but to ask the Human for the review mode and never set it; an unattended run is told to name the values and to leave the review mode for the Human's `tmb onboard`; only the empty ones are named, and once all are set the section is gone. |
| [host-refresh.test.ts](host-refresh.test.ts) | A project wired by one version and opened by another ends with the files a fresh init writes, and one refresh in the record; a second session start changes nothing; the Human's own entries stay; nothing is refreshed while a task is open; a project of another program, or with no record, is left alone; an older program refreshes too; a failed refresh names `tmb init` and records nothing; the session start's one line, attended and unattended; init takes out a tmb hook under an event it no longer uses. |

## Tasks, feature branches and review

| Test | What it proves |
|---|---|
| [feature-branch.test.ts](feature-branch.test.ts) | feature_start, the fold on close, the refusal of a task whose work is already on the feature branch, the close of a task whose earlier fold stopped before it recorded the close, and the backup push. |
| [feature-update.test.ts](feature-update.test.ts) | feature_start cuts from origin's base, fetched first, unless the local base is ahead or origin is out of reach; feature_update merges the base into the feature branch without rewriting it, fast-forwards a branch with no commit of its own, refuses a conflict changing nothing and naming the files, and the brief says whether the tip holds the base and groups no base change under a task. |
| [truest.test.ts](truest.test.ts) | In truest mode a task is cut from the base branch and feature_start is refused; close runs the checks and leaves the task in review with its worktree, folding nothing; a fail reopens the task and a pass covers only the commit it names; only a reviewer run reviews and only the Human waives; task_pr is the planner's and needs a pass or a waiver and an origin; a task keeps the review mode of its start. |
| [pull-request-state.test.ts](pull-request-state.test.ts) | A feature branch in pr_open moves to merged or closed from the pull request's state; a failed read leaves it; the planner's session start names the ones that ended. |
| [linguist.test.ts](linguist.test.ts) | Linguist's table marks programming languages (TypeScript, Shell, Dockerfile, Makefile) apart from prose, markup and data (Markdown, HTML, CSS, JSON, YAML, TOML, SQL); a file the table does not know, or a name with no extension it knows, is not refused; an extension of more than one type is refused only when every language left is programming. |

## Guards and hosts

| Test | What it proves |
|---|---|
| [decide.test.ts](decide.test.ts) | The host guards deny a write outside an open task's worktree. A run ends finished or stopped. tmb reads no shell command: [claude-code-hook.test.ts](claude-code-hook.test.ts) shows a push that skips git's hook is neither refused nor recorded. |
| [human-only.test.ts](human-only.test.ts) | The steps only the Human may take are both waivers, setting the review mode and `tmb remove`. The guard finds one in an agent's shell command however the program is reached, through a path, `env`, `sh -c` or `eval`, and not in a commit message or a here-document; Claude Code's Bash call is denied with the reason, whatever the role, and the deny is recorded. Any other shell command is allowed and not recorded. |
| [host-roles.test.ts](host-roles.test.ts) | Init gives each host a role, planner by default. A host set up as the reviewer has its main agent briefed, guarded and recorded as the reviewer, is told which feature branches wait for a review at their tip, and has a run that opens at its session start, ends with its verdict or with no verdict at its session end, and opens again at its next brief. A review of a feature branch links its run to that branch. |
| [claude-code-role-files.test.ts](claude-code-role-files.test.ts) | The worker's Claude Code agent file asks for worktree isolation; the reviewer's does not. |
| [claude-code-usage.test.ts](claude-code-usage.test.ts) | A Claude Code transcript gives tokens per model, each message counted once; an unreadable one gives no cost. |

## Code graph

| Test | What it proves |
|---|---|
| [graph.test.ts](graph.test.ts) | Each language is parsed and looked up from the base branch commit, never the working folder; a reference links only on proof; a concept whose code is gone is marked broken and kept; a task's commit is laid on top for its reads and dropped once it closes; misses are recorded. |

Two of the code graph's tests, beside the TypeScript rules in `src/engine/graph/languages/typescript/`, read a public repo, hono, at a fixed commit: that no function is left out, and that every link between files agrees with the TypeScript compiler.

- The tests never use the network. On a developer's machine run `bun tests/lib/pinned-repo.ts` once to fetch that commit (about 8 MB); until then the two tests are skipped and say so.
- CI fetches it before `bun test`, and there a missing folder or another commit fails.

## Command line

| Test | What it proves |
|---|---|
| [help.test.ts](help.test.ts) | A command at most two typing mistakes away, or one that starts with what was typed, is named; a swap of two neighbouring letters counts as one mistake; every match is named and none when none is close; a hidden command is never named; `upgrade` reaches `update` only through the table of other names. Colour is on for a terminal, off for a pipe, a file, `TERM=dumb` and `NO_COLOR`, on with `FORCE_COLOR`, and `NO_COLOR` wins over it. The short help groups the commands in one column. |
| [feedback.test.ts](feedback.test.ts) | The setting and its channel defaults, the two off switches, the first run's notice and question; a report's fields, cleaned paths and removed secrets; the body for the CLI route and the link for the form route, with a long report shortened; the form read from the repo and the built-in copy; `tmb feedback` and its `on`, `off` and `status`; the planner's two tools and their refusals. Not tested: the two routes against GitHub itself, and the labelling workflow. |
| [package-managers.test.ts](package-managers.test.ts) | From a release's `SHA256SUMS`, each channel gets a Homebrew cask, a Scoop manifest and three winget manifests under its own program name, with every platform's file and checksum, no placeholder left, and updates left to tmb. A missing checksum or a version that is not a release's is refused. Only the newest build on a channel counts as current. Publishing skips when the token or the repo is missing, pushes one commit, pushes nothing when the manifests are already there, and keeps the other channels' manifests. Install through a package manager is not supported yet (trustmybot/tmb#91). |
