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

The examples on this page say `tmb`; use the name of the program you installed. A project runs the program that initialised it: its hooks, its tool server and git's push hook call that program, so a project initialised with `tmb-dev` always runs dev. To move a project to another program, run that program's `init` in it. A program refuses a project whose record a newer tmb has reshaped, and names the program and version that did; run that one, or a newer one, there.

Before the channels had their own names, every channel installed as `tmb`. Such a `tmb` keeps following the channel it was on, and the installer points it out when it installs the channel's new name.

Each program keeps itself up to date on its own channel. When a session starts, tmb looks for a newer build there, at most once an hour, downloads it in the background, checks it against the published checksums and keeps it. It swaps the new build in only when a session ends, no other session of the same program is running, and no project tmb has served has an open task, so no session or task ever runs on two versions. Until then it keeps running the version it has, and with no network it simply runs that version.

| Command | Does |
|---|---|
| `tmb update` | Look for a newer build now and install it when no session is running and no task is open; otherwise keep it for the next swap and say so |
| `tmb update --check` | Only say whether a newer build is out |

Set `TMB_NO_UPDATE=1` to turn updates off. Each program keeps the kept build, the time of the last look and its session markers in a folder of its own name, such as `~/.local/state/tmb-dev` (`$XDG_STATE_HOME/tmb-dev` when that is set; Windows: `%LOCALAPPDATA%\tmb-dev`), so one never swaps another. A tmb run from source never updates itself.

Earlier builds installed to `~/.tmb/bin` (Windows: `%LOCALAPPDATA%\tmb\bin`). The script removes that old copy and names the program to run `init` with again, such as `tmb-dev`, in any project you set up with it.

`tmb --version` prints the program's name, its version, the source commit it was built from and the channel it follows. Dev builds print a version of the form `X.Y.Z-dev.<n>.gh<PR>`, where `<n>` counts the commits since the last stable release and `<PR>` is the pull request that brought in the build's commit.

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

At the first session the planner applies the settings it recommends ([Onboarding by itself](#onboarding-by-itself)); `tmb onboard` sets them yourself instead.

| Command | Does | Asks questions |
|---|---|---|
| `tmb init` | Prepares the project: creates its record, wires the host, adds git's push hook and indexes the code graph. It leaves tmb's settings empty. | No |
| `tmb onboard` | Sets tmb's settings for the project: a host's role, the base branch, the review mode and the checks. Run it again at any time. | Yes |
| `tmb remove` | Undoes what `tmb init` added ([Remove](#remove)). | No |

### init

`tmb init` first looks for the hosts tmb supports, today Claude Code. With none installed it stops, names the hosts it supports and changes nothing. With one installed it says which and uses it. With several it takes the one stored by an earlier init, else the first, and says so; `--host <id>` picks one. Run it once per host to use two hosts on one record.

It then wires tmb into that host, as listed below, and stores the host and its role, `planner` unless `--role reviewer` is given. It takes no other flag and sets no other setting: a setting stored before is kept, and the rest stay empty. It ends by printing the settings and the next steps: the command that starts the host in this folder and, for a planner, what to send first. A host set up as the reviewer gets one step, since it starts as the reviewer. The last line says which settings are still empty and how they get filled, or, with every setting stored, how to change them; it names the program to run `onboard` with, such as `tmb-dev`. The commands are coloured as in [Help and mistyped commands](#help-and-mistyped-commands). It never waits for input.

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
- In a project where `tmb init` has not run, it says so and changes nothing.

### Onboarding by itself

When a session starts as the planner and the base branch, the review mode or the checks is empty, the session start tells the planner so, with what tmb found in the project: the base branch, the checks and the review modes. Before other work the planner works out the settings it recommends, applies them with its `settings_set` tool and shows them, reminding you that `tmb onboard` can be run again at any time and that it can change a value when you ask. In an unattended run it names each value it applied. Once all are set, the session start says nothing about them.

`settings_get` reads the settings and what tmb found; `settings_set` is the planner's alone.

### Settings

Init, onboard and `settings_set` store the settings in the record. Each change to a setting is kept as an entry in the record's audit trail, and the newest entry is the value in force. Init and onboard print the settings in force, and `tmb config` shows them later.

`tmb init` also:

- Creates the project's record, `.tmb/trajectory.db`, which holds issues, notes and decisions.
- Registers tmb's tool server in the project's `.mcp.json` as `tmb`, keeping any other servers. It enables the server in `.claude/settings.local.json` so Claude Code loads it without asking.
- Adds three hooks to `.claude/settings.local.json`, the project settings file that is yours alone, and keeps everything else in that file:
  - A SessionStart hook runs `tmb hook session-start`, which starts each session with the planner role and the open work from the record.
  - A PreToolUse hook runs `tmb hook pre-tool-use` before Claude Code writes or edits a file or starts a subagent. tmb does not read shell commands; git's pre-push hook checks every push.
  - A SubagentStop hook runs `tmb hook subagent-stop` when a subagent ends.
- Writes two agent files in `.claude/agents/`, marked as tmb's: `worker.md`, the worker that carries out one task, and `reviewer.md`, the reviewer that judges a finished change. The reviewer gets no tool that edits files. Both get tmb's tools.
- Never overwrites an agent file in `.claude/agents/` that tmb did not write.
- In a git work tree, adds `.tmb/` and `.claude/settings.local.json` to `.gitignore`. It also adds `.mcp.json` if init created that file.
- In a git work tree, writes git's pre-push hook, so every push asks tmb first. A pre-push hook that is not tmb's is left alone, and init prints the line to add to it.
- Indexes the code graph of the base branch, once it has a commit.

Running init or onboard again with the same answers changes no file and records nothing.

Once the project is set up:

- tmb records each file write, subagent start and subagent end that the hooks report.
- tmb refuses file writes and subagent starts, saying why, while it cannot read the record or the record was made by a newer tmb.
- tmb lets a worker start only when its start prompt names an open task as `task_id=<id>` and that task's worktree exists. It records the worker's run from its start to its end.
- When tmb allows an action it says nothing, so Claude Code still asks you for permission as it would without tmb.

## Unattended runs

When no one can answer during a run, such as in CI, a scheduled job or an agent test, start it with `TMB_UNATTENDED=1` set, for example `TMB_UNATTENDED=1 claude -p "<prompt>"`. Each session it starts is told that no one can answer, so the planner applies its defaults, names each default it used, and stops with the reason when a default is not safe. Only the value `1` turns this on. Nothing is stored in the project, so your next session is a normal one, and tmb allows and refuses actions exactly as in a normal session.

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
| `tmb config` | Show the project's settings: host, base branch, review mode and checks, one per line. In a project where `tmb init` has not run, it says so. |
| `tmb feature start <name>` | Start a feature branch: tmb cuts it from the latest commit of the base branch, without checking it out anywhere, and records it. It refuses a name git does not accept as a branch name, a name starting with `-` or under `tmb/`, a branch that already exists, and a project with no base branch set. |
| `tmb feature list` | List the feature branches, each with the base branch and commit it was cut from, its state and the ids of its tasks |
| `tmb task start <issue-id> --kind code\|docs [--feature <name>] --intent <text> --file <path>... --criterion <text>... [--check <command>]...` | Start a task on an open issue. `--kind` says who writes it: `code` for a worker, `docs` for the planner. tmb cuts the branch `tmb/<short id>`, named after the last eight characters of the task id, from the tip of the feature branch, and adds its worktree under `.tmb/worktrees/`. Without `--feature` it uses the only open feature branch, and refuses when none or several are open. It also refuses when no base branch is set, or when a file overlaps one held by another open task. |
| `tmb task list [--state open\|closed\|all]` | List the open tasks, or the closed ones, each with the commit it closed at, or all |
| `tmb task brief <id>` | Show a task's kind, feature branch, spec, branch, worktree and the checks that run when it closes |
| `tmb task close <id>` | Run the checks on the task's commit; when they all pass, close the task, fold it into its feature branch and push that branch to `origin` |

Add `--json` to any of them for JSON output. A change you make here is recorded as yours, and one made through the tools names the agent's role and host.

A task closes only when its worktree has no uncommitted changes and has at least one commit past the point it was cut from. tmb then runs the project's checks, followed by the task's own, one after another in the worktree. Each check gets 10 minutes. Every run is recorded with its start, its end, each command's exit code and the end of its output. If a check fails, the task stays open, and tmb names the command and shows the end of its output. A task with no checks at all never closes.

When the checks pass, tmb folds the task into its feature branch. If the feature branch is still where the task was cut from, it moves to the task's commit. If another task folded in first, tmb rebases the task onto the new tip and runs every check again on the rebased commit. A rebase conflict or a failing check leaves the task open, the feature branch where it was and the worktree as it was, and tmb names the conflicting paths or the failing command. If the feature branch is checked out somewhere, tmb moves it there too, and refuses the close while that checkout has uncommitted changes. The closed task records its kind, the review mode `agile` and the commit it folded. tmb then removes the task's worktree and branch, and pushes the feature branch to `origin`, never forced. The close reports whether the push went through, failed with git's message, or was skipped because there is no `origin`. A failed push does not reopen the task.

## Move a plugin project

A project that used the [TMB plugin](https://github.com/trustmybot/plugin) can bring its records over. In the project's folder:

```sh
tmb migrate
```

tmb finds the plugin's database (`.claude/tmb/trajectory.db` in the folder or one above it; `--from <path>` names another), and copies the records of one repo into this project's new record: its issues with their notes and decisions, its tasks with their branches and commits, their reviews, check runs and agent runs. Each copied record keeps its original time. When the plugin served several repos, tmb picks the one named like this folder; `--repo <name>` names another. The plugin's database is only read and stays unchanged, so the plugin keeps working. A task the plugin left unfinished stays open, and tmb holds its own updates while any task is open; `tmb migrate` says how many it left open.

The plugin's own features that tmb does not carry over stay behind: its audit log, world model, roundtables, cheatcodes, lanes, embeddings, session handoffs and pull request records. So do the plugin's discussion records of a kind tmb lacks (intent, question, answer and analysis; tmb keeps notes and decisions), and a task's plugin status beyond open or closed; tmb says how many records of each kind it left behind. tmb refuses a plugin database of another schema version than 76, and a project whose record already holds issues or tasks, so it runs once. Run `tmb init` afterwards if you have not.

## Remove

```sh
tmb remove
```

It removes only what `tmb init` added:

- The three hooks, keeping your own hooks and settings.
- The agent files tmb wrote in `.claude/agents/`, keeping any you wrote.
- The tool server's entry and its enabled line.
- `.mcp.json` itself, only if init created that file and nothing else is left in it.
- git's pre-push hook, if tmb wrote it.

It keeps the record in `.tmb/`, because that is your data; delete the folder yourself to drop it. It does not remove the `.gitignore` lines.
