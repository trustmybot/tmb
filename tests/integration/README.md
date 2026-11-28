# Integration tests

The real engine process through a real door: the tool server, the command line, a host event passed through the adapter. They use no model and run with `bun test` on every pull request ([all layers](../README.md)). A test not listed here says what it proves in its header comment.

## Setup and the record's doors

| Test | What it proves |
|---|---|
| [cli/doors.test.ts](cli/doors.test.ts) | Both ways into the record, as separate processes: init, onboard and remove, the tool server over stdio, the record commands, and session start. |
| [cli/init-remove.test.ts](cli/init-remove.test.ts) | init writes the three registrations (the tool server, the role files, the event hooks) and the record; remove takes back only what init added and leaves every file the Human wrote as it was. |
| [cli/init-onboard.test.ts](cli/init-onboard.test.ts) | `tmb init` refuses any flag but the host and role, runs git init in a folder with no repo, and writes a reviewer agent file with no editing tools; `tmb onboard` refuses an unprepared project, changes a setting and can be run twice; `tmb remove` undoes `tmb init`, keeping the record and the `.gitignore` lines; `tmb setup` is refused as an unknown command. Init's ideal case and the first session are flows 1.1 and 2.1 ([workflow](../workflow/README.md#flows)). |
| [cli/settings.test.ts](cli/settings.test.ts) | `tmb init`, `tmb onboard` and `tmb config` as the Human runs them: init finds the host on PATH, onboard's answers land in the record, and no run waits for input. |
| [adapters/contract.test.ts](adapters/contract.test.ts) | One shared set of tests every host adapter must pass: init and onboard, removal, session start, guarded tool calls, agent start and stop, and a host set up as the reviewer. Claude Code raises a worker's folder when the worker names its task with task_brief or task_close. |

## Tasks, review and the push gate

| Test | What it proves |
|---|---|
| [engine/task-flow.test.ts](engine/task-flow.test.ts) | The task commands, the task tools over stdio, and the hooks init wired, which let a worker start only on an open task and record its run. |
| [adapters/guard-hooks.test.ts](adapters/guard-hooks.test.ts) | The PreToolUse hook init wired, run through a shell as Claude Code runs it: an allow prints nothing and a broken record denies, from the project folder or any subfolder of it. |
| [cli/human-only.test.ts](cli/human-only.test.ts) | Each Human-only command run with no terminal is refused, changes no file and adds no entry by the Human to the record; on a terminal, an answer other than yes refuses it and yes runs it; with unattended mode on, only the review mode may be set with no terminal; Claude Code's hook denies a Human-only step in a Bash call. Tests take such a step as the Human on a pseudo-terminal, through [tests/lib/human-terminal.ts](../lib/human-terminal.ts). |
| [engine/push-gate.test.ts](engine/push-gate.test.ts) | Init writes git's pre-push hook and remove deletes it. A push typed by hand that brings unreviewed commits onto the base branch is refused, and so is deleting it; a feature branch's backup push goes through; the base branch takes the branch once the reviewer passed its tip. It needs a real origin, so it is an integration test. |
| [engine/review-mark.test.ts](engine/review-mark.test.ts) | Against a stand-in for GitHub: a pass, a fail and a waiver each set the commit status `tmb/review` on the reviewed commit; a mark that could not be sent is recorded and sent at the next occasion; a pull request and `tmb onboard` say whether the base branch requires the mark. |

## Code graph and dashboard

| Test | What it proves |
|---|---|
| [cli/workspace-commands.test.ts](cli/workspace-commands.test.ts) | The record and graph commands in a workspace of several repos, typed by hand from the workspace folder and from a repo folder below it. |
| [dashboard/pages.test.ts](dashboard/pages.test.ts) | `tmb dashboard`, started from outside the repository over a [prepared record](dashboard/record.ts), serves the page with its bundled script and Tailwind styles. Every API read returns the record. The Human's notes, decisions, edits, closes and reopens go through the engine's operations. A request to another host name, a change without the token and an edit from a stale page are refused. Every page (overview, issues, one issue, tasks, one task, runs and gate decisions, audit) is rendered against the running server and shows its data. |
| [dashboard/pull-requests.test.ts](dashboard/pull-requests.test.ts) | The dashboard's reads move a feature branch whose pull request merged or closed, at most once a minute per branch. |
| [dashboard/workspace.test.ts](dashboard/workspace.test.ts) | The dashboard's Code page in a workspace of several repos lists the repos first, and each graph read names the repo whose graph it reads. |

## The command line

| Test | What it proves |
|---|---|
| [cli/help.test.ts](cli/help.test.ts) | `--help` and `help` print the grouped help on stdout and exit 0; `tmb` alone prints it on stderr and exits 2; the commands only a host or git calls appear only with `--all`; every command and sub-command answers `--help` with its own detail; an unknown command, also one level down, prints the tip and one usage line on stderr and exits 2; an unknown flag exits 2; piped output has no colour codes. |
