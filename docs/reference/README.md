# Reference

Install, upgrade and configuration.

## Install

The dev channel holds a build of every merge to the base branch. The install needs no login.

macOS and Linux:

```sh
curl -fsSL https://github.com/trustmybot/tmb-releases/releases/download/dev/install.sh | sh
```

Windows, in PowerShell:

```powershell
irm https://github.com/trustmybot/tmb-releases/releases/download/dev/install.ps1 | iex
```

The script downloads the file for your platform, checks it against the published checksums, refuses to install on a mismatch, and puts the program in `~/.local/bin` (Windows: `%USERPROFILE%\.local\bin`) under its channel's name ([Channels and updates](#channels-and-updates)), the folder Claude Code also installs to. If that folder is not on your PATH, the script adds it to your shell profile (Windows: your user PATH) and says where; open a new terminal afterwards. Set `TMB_NO_MODIFY_PATH=1` to skip that and have it print the line to add instead. Run the same command again to upgrade.

## Channels and updates

Each channel installs as a program of its own name, so channels and versions live side by side on one machine. Pick the channel with `TMB_CHANNEL`, or one exact release with `TMB_INSTALL_VERSION`, when you install:

| Program | Follows | Install |
|---|---|---|
| `tmb-dev` | dev (default): a build of every merge to the base branch. | The commands above. |
| `tmb-rc` | rc: release candidates, tagged `vX.Y.Z-rc.N`. | `curl -fsSL https://github.com/trustmybot/tmb-releases/releases/download/dev/install.sh \| TMB_CHANNEL=rc sh` |
| `tmb` | stable: releases, tagged `vX.Y.Z`. | `curl -fsSL https://github.com/trustmybot/tmb-releases/releases/download/dev/install.sh \| TMB_CHANNEL=stable sh` |
| `tmb-<version>` | One rc or stable release. It never updates itself. | `curl -fsSL https://github.com/trustmybot/tmb-releases/releases/download/dev/install.sh \| TMB_INSTALL_VERSION=1.0.0 sh` |

On Windows, set `$env:TMB_CHANNEL` or `$env:TMB_INSTALL_VERSION` before running the PowerShell command, with `install.ps1` in place of `install.sh`.

The examples on this page say `tmb`; use the name of the program you installed. A project runs the program that initialised it: its hooks, its tool server and git's push hook call that program, so a project initialised with `tmb-dev` always runs dev. To move a project to another program, run that program's `init` in it. A program refuses a project whose record a newer tmb has reshaped, and names the program that did; run that one there, or update this program with its `update` command (a program pinned to one release names the installer command instead).

Before the channels had their own names, every channel installed as `tmb`. Such a `tmb` keeps following the channel it was on, and the installer points it out when it installs the channel's new name.

Each program keeps itself up to date on its own channel. When a session starts, tmb looks for a newer build there, at most once an hour, downloads it in the background, checks it against the published checksums and keeps it. `tmb update`, or the end of any session, installs it at once; with no network tmb simply runs the version it has.

A session that is running keeps the build it started with, and so does its project: while it runs, every tmb call there (its hooks, its tool server, git's push hook, a command you type) runs that build, the record keeps its shape and the host files are left as they are. The session moves to the new build by itself at its next tool call once no task is open in the project, and says so in one line; you do nothing, and the conversation is kept. If the move fails, the session keeps its build and says how to restart tmb's tool server (in Claude Code: `/mcp`, then Reconnect on tmb). `tmb update` names each session still on an old build by its folder, title and start time, and why. The replaced build is kept; tmb says how many old builds no session uses and their size, and never deletes one by itself.

A project whose record a newer tmb reshaped never holds an update back: this program can do nothing there.

| Command | Does |
|---|---|
| `tmb update` | Look for a newer build now and install it when no session is running and no task is open; otherwise keep it for the next swap and say so |
| `tmb update --check` | Only say whether a newer build is out |

Set `TMB_NO_UPDATE=1` to turn updates off. Each program keeps the kept build, the time of the last look and its session markers in a folder of its own name, such as `~/.local/state/tmb-dev` (`$XDG_STATE_HOME/tmb-dev` when that is set; Windows: `%LOCALAPPDATA%\tmb-dev`), so one never swaps another. A tmb run from source never updates itself.

Earlier builds installed to `~/.tmb/bin` (Windows: `%LOCALAPPDATA%\tmb\bin`). The script removes that old copy and names the program to run `init` with again, such as `tmb-dev`, in any project you set up with it.

`tmb --version` prints the program's name, its version, the source commit it was built from and the channel it follows. Dev builds print a version of the form `X.Y.Z-dev.<n>.gh<PR>`, where `<n>` counts the commits since the last stable release and `<PR>` is the pull request that brought in the build's commit.

After an update, each project catches up by itself. Its database is upgraded the first time tmb opens it. The files `tmb init` wrote are refreshed at the next session start, when no task is open, and the session says so in one line; your agent program reads those files when a session starts, so the new ones apply from the session after. A project you set up with another channel's program is left alone: run that program's `init` to move it. If a refresh fails, the session goes on and the line names `tmb init`.

## Set up a project

In the project's root folder:

```sh
tmb init
```

Init ends by naming the next steps. For Claude Code as the planner:

```
tmb is set up for Claude Code. Next:
  1. Run `claude` in this folder.
  2. Send `@bro`.
```

Init asks nothing. At the first session the planner asks you for the review mode among its onboarding questions, with what each mode costs; it is your choice, since it decides how many tokens the project uses, and no task starts until it is set ([The review mode is yours](#the-review-mode-is-yours)). The planner applies the other settings it recommends ([Onboarding by itself](#onboarding-by-itself)); `tmb onboard` sets them yourself instead.

| Command | Does | Asks questions |
|---|---|---|
| `tmb init` | Prepares the project: creates its record, wires the host, adds git's push hook and indexes the code graph. It leaves tmb's other settings empty. | None |
| `tmb onboard` | Sets tmb's settings for the project: a host's role, the base branch, the review mode and the checks; in a workspace, each repo's base branch and checks. Run it again at any time. | Yes |
| `tmb remove` | Undoes what `tmb init` added ([Remove](#remove)). | No |

### init

`tmb init` first looks for the hosts tmb supports, today Claude Code. With none installed it stops, names the hosts it supports and changes nothing. With only Codex installed it sets Codex up and warns that Codex is not supported yet. With one installed it says which and uses it. With several it takes the one stored by an earlier init, else the first, and says so; `--host <id>` picks one. Run it once per host to use two hosts on one record.

It then wires tmb into that host, as listed below, and stores the host and its role, `planner` unless `--role reviewer` is given. It takes no other flag and sets no other setting: a setting stored before is kept, and the rest stay empty. It ends by printing the settings and the next steps: the command that starts the host in this folder and, for a planner, what to send first. A host set up as the reviewer gets one step, since it starts as the reviewer. The last line says which settings are still empty and how they get filled, or, with every setting stored, how to change them; it names the program to run `onboard` with, such as `tmb-dev`. The commands are coloured as in [Help and mistyped commands](#help-and-mistyped-commands).

Run again, init replaces what an earlier tmb wrote and takes out what this version no longer uses: tmb's role files for roles that no longer exist, and tmb's hooks under an event they no longer use. Your own entries stay.

It asks nothing and never waits for input, on a terminal or not. With no review mode stored, it ends by saying that none is chosen, how to choose it, and that no task starts until it is.

### onboard

`tmb onboard` asks four questions, each offering the value stored now:

| Question | Default | Flag |
|---|---|---|
| The role of the host's main agent | `planner`; `reviewer` makes the host the project's reviewer. | `--role planner\|reviewer` |
| The base branch, the branch pull requests merge into | The branch origin names as its default, else the current branch, else `main`. Outside a git repository there is no default. | `--base <branch>` |
| The review mode | `agile` or `truest`. | `--review-mode <mode>` |
| The checks, the shell commands that must pass before a task closes | The commands it finds in the project: the `lint`, `typecheck` and `test` scripts of `package.json`, run with bun, npm, pnpm or yarn as the lockfile shows; `pytest` for a Python project; `cargo test` for Rust; `go test ./...` for Go. | `--check <command>`, once per command; the commands given replace the list |

- The host is the one init stored; `--host <id>` names another host init wired.
- A flag answers its question without asking, and `--yes` takes the default of every question no flag answers.
- Onboard asks only when it runs in a terminal. Without one, each question takes its default, so it never waits for input.
- The review mode has no default. Without a terminal it is set only by `--review-mode`, also when `--yes` is given; otherwise it stays as it is and onboard says so.
- In a project where `tmb init` has not run, it says so and changes nothing.

### One repo or a workspace of several

When the folder you run `tmb init` in is a git work tree, or inside one, the project is one repo, the folder itself, named `.`. When it is in no git work tree and holds no git repo below it, init runs `git init` in it and says so. It does so after it has written its own files, so the first run adds no lines to `.gitignore`: run `tmb init` a second time, or `.tmb/` is not ignored (trustmybot/tmb#180). When it is not a git work tree but holds git repos, tmb sets it up as a workspace: its repos share one record in that folder ([One record, one or several repos](../architecture/WORKFLOW.md#one-record-one-or-several-repos)). init then also:

- Finds the repos up to two folders down and stores them in the `repos` setting, each with the base branch its own git points at and the checks found in it. It records each top-level folder that is not a repo as `{"git": false}`, and leaves it alone. It prints a line for each repo or folder it added, with where a base branch came from, and for each one it dropped because it is gone. A repo's policy set before is kept.
- Writes git's pre-push hook into each repo that is not exempt, and `tmb remove` deletes each.
- Indexes each repo's code graph from its own base branch.

`tmb onboard --repo <name>` sets one repo: `--base <branch>` and `--check <command>` set its base branch and checks, and `--exempt` makes tmb do no work in it. With one repo tmb works in, `--repo` may be left out. On a terminal without `--repo`, onboard asks for each repo's base branch and checks in turn. The planner sets the same with `settings_set` and `repos`; a repo it names keeps no part of its old policy, and repos it does not name keep theirs.

In a workspace, `base_branch` and `checks` are not used: each repo has its own in `repos`, and `settings_set` refuses them. `tmb feature start <name> --repo <name>` and `tmb task start ... --repo <name>` name the repo; with several repos, one that names none is refused with the list.

### Onboarding by itself

When a session starts as the planner and the base branch, the review mode or the checks is empty, the session start tells the planner so, with what tmb found in the project: the base branch, the checks and the review modes. Before other work the planner works out the base branch and the checks it recommends, applies them with its `settings_set` tool and shows them, reminding you that `tmb onboard` can be run again at any time and that it can change a value when you ask. In an unattended run it names each value it applied. The review mode it never applies: it asks you for it among its onboarding questions, with the host's question tool (AskUserQuestion in Claude Code), showing each mode with what it costs and marking agile as recommended, and stores your answer. Once all are set, the session start says nothing about them.

`settings_get` reads the settings and what tmb found; `settings_set` is the planner's alone.

### The review mode is yours

The review mode decides how many tokens a project uses, so tmb recommends one and never picks it. While none is set, tmb refuses to start a task and says how to choose. There are three ways:

- answer the planner's onboarding question at the first session. It stores your answer;
- run `tmb onboard` on a terminal;
- run `tmb onboard --review-mode <mode> --yes` to set it without a question.

`tmb init` never asks for it.

In an unattended run nobody can answer, so the task start is refused, the refusal names `tmb onboard`, and the planner cannot set or change the mode. Set it before the run. The record keeps which way the mode was chosen.

### Settings

Init, onboard and `settings_set` store the settings in the record. Each change to a setting is kept as an entry in the record's audit trail, and the newest entry is the value in force. Init and onboard print the settings in force, and `tmb config` shows them later.

`tmb init` also:

- Creates the project's record, `.tmb/trajectory.db`, which holds issues, notes and decisions.
- Registers tmb's tool server in the project's `.mcp.json` as `tmb`, keeping any other servers. It enables the server in `.claude/settings.local.json` so Claude Code loads it without asking.
- Adds four hooks to `.claude/settings.local.json`, the project settings file that is yours alone, and keeps everything else in that file:
  - A SessionStart hook runs `tmb hook session-start`, which starts each session with the role this host was set up with, the planner unless you chose the reviewer, and the open work from the record.
  - A PreToolUse hook runs `tmb hook pre-tool-use` before Claude Code writes or edits a file, starts a subagent, or reads a task's brief or closes a task through tmb's tools. tmb does not read shell commands; git's pre-push hook checks every push.
  - A SubagentStop hook runs `tmb hook subagent-stop` when a subagent ends.
  - A SessionEnd hook runs `tmb hook session-end` when the session ends.
- Writes two agent files in `.claude/agents/`, marked as tmb's: `worker.md`, the worker that carries out one task, and `reviewer.md`, the reviewer that judges a finished change. The reviewer gets no tool that edits files. Both get tmb's tools.
- Never overwrites an agent file in `.claude/agents/` that tmb did not write.
- In a git work tree, adds `.tmb/` and `.claude/settings.local.json` to `.gitignore`. It also adds `.mcp.json` if init created that file.
- In a git work tree, writes git's pre-push hook, so every push asks tmb first; in a workspace, one in each repo tmb works in. A pre-push hook that is not tmb's is left alone, and init prints the line to add to it.
- Indexes the code graph of the base branch, once it has a commit; in a workspace, each repo's from its own base branch.

Running init or onboard again with the same answers changes no file and records nothing.

Once the project is set up:

- tmb records each file write, subagent start and subagent end that the hooks report.
- tmb refuses file writes and subagent starts, saying why, while it cannot read the record or the record was made by a newer tmb.
- tmb lets a worker start only when its start prompt names an open task as `task_id=<id>` and that task's worktree exists. It records the worker's run from its start to its end.
- When tmb allows an action it says nothing, so Claude Code still asks you for permission as it would without tmb.

## Unattended runs

When no one can answer during a run, such as in CI, a scheduled job or an agent test, start it with `TMB_UNATTENDED=1` set, for example `TMB_UNATTENDED=1 claude -p "<prompt>"`. Each session it starts is told that no one can answer, so the planner applies its defaults, names each default it used, and stops with the reason when a default is not safe. The review mode is never one of those defaults: with none set, the run's first task is refused ([The review mode is yours](#the-review-mode-is-yours)). Only the value `1` turns this on. Nothing is stored in the project, so your next session is a normal one, and tmb allows and refuses actions exactly as in a normal session.

## Help and mistyped commands

`tmb --help` lists the commands in four groups, one line each. `tmb help <command>` and `tmb <command> --help` give that command's detail, and the same works one level down, as in `tmb task close --help`. The commands only a host or git calls are left out; `tmb help --all` lists them last.

A command tmb does not know is answered with the closest one, a usage line and where to read more, never with the full help:

```
error: unrecognized command 'inti'

  tip: a similar command exists: 'init'

Usage: tmb <COMMAND>

For more information, try 'tmb --help'.
```

- A command is named when it is at most two typing mistakes away, or starts with what was typed. Every match is named; with none, there is no tip.
- `tmb upgrade` is not a command; its tip names `update`.
- A usage mistake goes to stderr and exits with code 2: an unknown command, a flag a command does not take, or `tmb` with no command, which prints the short help.
- Help and errors are coloured on a terminal. `NO_COLOR` turns colour off and `FORCE_COLOR` turns it on; with both set, `NO_COLOR` wins. Output sent to a file or a pipe, or a terminal with `TERM=dumb`, has no colour.

## Check this machine and project

`tmb doctor` checks the machine and the project you run it in, and prints one line per check: `✓` fine, `!` a warning, `✗` a failure, each with the command or the step that fixes it. It only reads, and exits 1 when a check failed.

| Command | Does |
|---|---|
| `tmb doctor` | Runs every check and prints what it finds. |
| `tmb doctor --json` | Prints the same findings as data. |
| `tmb doctor --fix` | Asks about each fix it can do, one at a time, `[y/N]`, and does only what you say yes to. Without a terminal it changes nothing and says so. |

| On this machine | Fix |
|---|---|
| The program: its name, version, channel, where it is installed, and whether it is the one on the PATH | The install step |
| Old builds kept on disk, each with its version, its size and the sessions that use it | Deletes each one no running session uses, on your yes. One a session uses is never offered |
| A downloaded update that has not applied, and why; a look for an update that failed | `tmb update` |
| Entries of sessions whose process ended | Removes them, on your yes |
| Files an update left when it stopped half-way | Removes them, on your yes |
| Other channels' programs installed side by side, each with its version | Shown only |
| The state folder can be read and written | The step that gives you access |

| In this project | Fix |
|---|---|
| The record: readable, its shape's version, and which program wrote it | Repairs a damaged record on your yes, keeping the damaged file beside it; for a newer shape, the program to use |
| The host files and git's pre-push hook match what this tmb wires | `tmb init --host <id>` |
| The program the project is tied to, and any running session that keeps it on an older build | Shown only |
| Empty settings, and the review mode not chosen | `tmb onboard` |
| Runs and checks with a start and no end, and open tasks no agent run is on | Shown only: the planner decides |
| Worktrees and branches of closed and dropped tasks still on disk | Removes each on your yes, by the same rules as closing a task: a worktree with work nobody committed stays |
| The code graph behind its base branch, built by an older indexer, or with files not parsed | `tmb index` |
| GitHub's CLI installed and signed in | `gh auth login` |
| Other records in a folder above the project or below it | Shown only |

- **It never deletes without your yes**, and never touches a file tmb did not write.
- **It runs with a broken record.** Every check that does not need the record still runs, and the ones that do say why they were skipped. A record an older tmb wrote is upgraded by the next tmb command, not by doctor.
- **A check that fails by itself looks like tmb's own bug.** Its line says so and names `tmb feedback`, which can put that error in a report.
- **The planner's session start names what doctor finds**, in one line: how many findings, and how many runs or tasks have a start and no end. It runs only the quick checks, and says nothing when there is nothing to say.

## Report a bug in tmb

When tmb itself goes wrong, a bug report can reach tmb's maintainers as a public issue on `trustmybot/tmb`, from your own GitHub account. Nothing is ever sent by itself: you read each report whole and say yes or no to it.

| Command | Does |
|---|---|
| `tmb feedback [<text>]` | Drafts a report, shows it whole and asks `[y/N]` before sending. `<text>` says what you were doing; without it tmb asks. The report includes the last error tmb gave on this machine in the past 24 hours. |
| `tmb feedback on` and `off` | Joins or leaves the feedback program. |
| `tmb feedback status` | Shows whether the program is on, and why. |

- **On or off only decides whether the planner offers a report.** With the program on, the planner may draft one when tmb breaks, and shows it to you first. `tmb feedback` works either way.
- **The default follows the channel.** On dev and rc the program is on, and the first run says so once. On stable it is off, and the first run asks once whether to join; no answer means off. The notice comes at the end of `tmb init` on a terminal, else at the planner's first session; the question on stable is always the planner's, as init asks nothing.
- **The setting is yours, not the project's.** It is kept once per machine for each channel's program.
- **How a report is sent.** With GitHub's CLI signed in, tmb files the issue after your yes and prints its link. Otherwise it opens the repo's bug form in your browser, filled in, and you press submit there; with no browser it prints the link. A report too long for a link is saved to a file, and the form asks you to attach it.
- **Without a terminal** the draft is only saved to a file, and nothing is sent.
- **What a report holds.** tmb's version, channel and program name, your OS, your agent program and its version, the command that failed, the error and tmb's own stack, the kinds of the last ten events in the record, and your sentence on what you were doing.
- **What it never holds.** Source code, file contents, prompts, an agent's messages or environment variables. Your home folder is written as `~` and the project's folder as `<project>`, and values that look like tokens or passwords are removed. That cleaning is best effort, which is why you read every report.
- `tmb feedback` takes no flags; any flag exits with code 2.

| Variable | Does |
|---|---|
| `TMB_NO_FEEDBACK=1` | Turns the program off, whatever the setting says. Only `1` or `true` counts. |
| `DO_NOT_TRACK=1` | The same. |
| `TMB_FEEDBACK_REPO=owner/name` | Sends reports to another repo, to try the two routes on a fork. |

The planner has two tools for this, `feedback_draft` and `feedback_send`. Both are the planner's alone and are refused while the program is off. `feedback_send` is refused unless it carries your yes to that draft. In an [unattended run](#unattended-runs) a draft is kept as a file and no report is sent.

## The record from the command line

The planner records work through tmb's tools. You can read and change the same record yourself:

| Command | Does |
|---|---|
| `tmb issue create <title> [--body <text>] [--milestone <name>]` | Record a new issue |
| `tmb issue list [--state open\|closed]` | List issues |
| `tmb issue show <id>` | Show an issue with its notes and decisions |
| `tmb issue close <id>`, `tmb issue reopen <id>` | Close or reopen an issue |
| `tmb note <issue-id> <text> [--decision]` | Add a note, or a decision with `--decision` |
| `tmb search <query>` | Search issues, notes and decisions |
| `tmb history <id>` | Show every recorded change to an issue or note |
| `tmb config` | Show the project's settings: host, each host's role, base branch, review mode, checks and, in a workspace, the repos, one per line. In a project where `tmb init` has not run, it says so. |
| `tmb feature start <name>` | Start a feature branch: tmb cuts it from the latest commit of the base branch, without checking it out anywhere, and records it. It refuses a name git does not accept as a branch name, a name starting with `-` or under `tmb/`, a branch that already exists, and a project with no base branch set. In truest mode it is refused: a task there is cut from the base branch. In a workspace, `--repo <name>` names the repo. |
| `tmb feature list` | List the feature branches, each with the base branch and commit it was cut from, its state and the ids of its tasks |
| `tmb task start <issue-id> --kind code\|docs [--feature <name>] --intent <text> --file <path>... --criterion <text>... [--check <command>]...` | Start a task on an open issue. `--kind` says who writes it: `code` for a worker, `docs` for the planner. tmb cuts the branch `tmb/<short id>`, named after the last eight characters of the task id, from the tip of the feature branch, and adds its worktree under `.tmb/worktrees/`. Without `--feature` it uses the only open feature branch, and refuses when none or several are open. It also refuses when no base branch is set or no review mode is chosen. When a file is also in another open task's spec, the task still starts and tmb names the tasks that share it. In truest mode the task is cut from the base branch and `--feature` is refused. In a workspace, `--repo <name>` names the repo. |
| `tmb task list [--state open\|in_review\|closed\|all]` | List the open tasks, or those in review, or the closed ones, each with the commit it closed at, or all |
| `tmb task brief <id>` | Show a task's kind, feature branch, spec, branch, worktree and the checks that run when it closes |
| `tmb task close <id>` | Run the checks on the task's commit; when they all pass, close the task, fold it into its feature branch and push that branch to `origin`. In truest mode the task is not folded: it goes into review at that commit. |
| `tmb feature brief <name>` | Show a feature branch's tip, its tasks, reviews and waivers |
| `tmb feature waive <name> --reason <text>` | Waive the review of a feature branch at its tip. The Human only. |
| `tmb feature pr <name> --title <text> [--body <text>]` | Open the feature branch's pull request into the base branch, once the reviewer passed its tip or you waived the review |
| `tmb task drop <id> --reason <text>` | End an open task, or a truest task in review, without its work. The task is recorded as dropped with the reason. Its worktree is removed by the rules below for a closed task; its branch is kept while it holds commits, and tmb names it and the command that deletes it. `tmb task start --replaces <id>` starts the task that takes up a dropped task's work another way, and is refused for a task that is not dropped. `tmb task list --state dropped` lists the dropped tasks. |
| `tmb task waive <id> --reason <text>` | Waive the review of a truest task at its commit. The Human only. |
| `tmb task pr <id> --title <text> [--body <text>]` | Open a truest task's pull request into the base branch, once the reviewer passed it or you waived the review |
| `tmb graph map\|find\|symbol\|scope\|concepts` | Look things up in the code graph: the project's files with their summaries, where a name lives, what calls it, a draft of a task's files, and the recorded concepts. `--task <id>` reads as that open task sees the code. |
| `tmb index [--rebuild]` | Bring the code graph up to date, or build it again from nothing |
| `tmb dashboard [--port <n>] [--project <dir>]` | Open the dashboard, a local web page over the record |

Add `--json` to any of them for JSON output. A change you make here is recorded as yours, and one made through the tools names the agent's role and host.

A task closes only when its worktree has no uncommitted changes and has at least one commit past the point it was cut from. tmb then runs the project's checks, followed by the task's own, one after another in the worktree. Each check gets 10 minutes. Every run is recorded with its start, its end, each command's exit code and the end of its output. If a check fails, the task stays open, and tmb names the command and shows the end of its output. A task with no checks at all never closes.

When the checks pass, tmb folds the task into its feature branch. If the feature branch is still where the task was cut from, it moves to the task's commit. If another task folded in first, tmb rebases the task onto the new tip and runs every check again on the rebased commit. A rebase conflict or a failing check leaves the task open, the feature branch where it was and the worktree as it was, and tmb names the conflicting paths or the failing command. If the feature branch is checked out somewhere, tmb moves it there too, and refuses the close while that checkout has uncommitted changes. The closed task records its kind, the review mode it was started in and the commit it folded. tmb then removes the task's worktree and branch, unless files are left in the worktree (see below), and pushes the feature branch to `origin`, never forced. The close reports whether the push went through, failed with git's message, or was skipped because there is no `origin`. A failed push does not reopen the task.

What tmb does with a closed task's worktree depends on what is left in it (trustmybot/tmb#132):

| Left in the worktree | tmb |
|---|---|
| Nothing | Removes the worktree and the branch. |
| Only files git ignores, such as build output | Removes both, and the close names the files it dropped. |
| Untracked files git does not ignore | Keeps both. The close names the files and the command that removes the worktree. |
| Changed or staged tracked files | Keeps both, and the close names the files. |
| A lock set by the host | Keeps both, and the close says so. |

- A file nobody ignored may be work that was not committed, so tmb never deletes it by itself.
- tmb tries a kept worktree again when the planner's session starts with no task open or in review. It goes once its files are gone or ignored, or the lock is lifted.
- The main folder is never removed.
- In truest mode, where a task opens its own pull request, the worktree follows the same rules and the branch is kept for the pull request.

## Move a plugin project

A project that used the [TMB plugin](https://github.com/trustmybot/plugin) can bring its records over. In the project's folder, init first, then migrate:

```sh
tmb init
tmb migrate
```

tmb finds the plugin's database (`.claude/tmb/trajectory.db` in the folder or one above it; `--from <path>` names another), and copies the records of one repo into the new record `tmb init` made for this project, and names that record: its issues with their notes and decisions, its tasks with their branches and commits, their reviews, check runs and agent runs. Each copied record keeps its original time. When the plugin served several repos, tmb picks the one named like this folder; `--repo <name>` names another. The plugin's database is only read and stays unchanged, so the plugin keeps working. A task the plugin left unfinished stays open, and tmb holds its own updates while any task is open; `tmb migrate` says how many it left open.

The plugin's own features that tmb does not carry over stay behind: its audit log, world model, roundtables, cheatcodes, lanes, embeddings, session handoffs and pull request records. So do the plugin's discussion records of a kind tmb lacks (intent, question, answer and analysis; tmb keeps notes and decisions), and a task's plugin status beyond open or closed; tmb says how many records of each kind it left behind. tmb refuses a plugin database of another schema version than 76, and a project whose record already holds issues or tasks, so it runs once. It also refuses before `tmb init` has made the project's record, and a record in a folder above a repo that the record does not serve, naming that record; it never creates a record itself.

## Remove

```sh
tmb remove
```

It removes only what `tmb init` added:

- The four hooks, keeping your own hooks and settings.
- The agent files tmb wrote in `.claude/agents/`, keeping any you wrote.
- The tool server's entry and its enabled line.
- `.mcp.json` itself, only if init created that file and nothing else is left in it.
- git's pre-push hook, if tmb wrote it.

It keeps the record in `.tmb/`, because that is your data; delete the folder yourself to drop it. It does not remove the `.gitignore` lines.
