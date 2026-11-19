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

The script downloads the file for your platform, checks it against the published checksums, refuses to install on a mismatch, and puts tmb in `~/.local/bin` (Windows: `%USERPROFILE%\.local\bin`), the folder Claude Code also installs to. If that folder is not on your PATH, the script adds it to your shell profile (Windows: your user PATH) and says where; open a new terminal afterwards. Set `TMB_NO_MODIFY_PATH=1` to skip that and have it print the line to add instead. Run the same command again to upgrade.

## Channels and updates

An install follows one channel, picked with `TMB_CHANNEL` when you install:

| Channel | Holds | Install |
|---|---|---|
| dev (default) | A build of every merge to the base branch. | The commands above. |
| rc | Release candidates, tagged `vX.Y.Z-rc.N`. | `curl -fsSL https://github.com/trustmybot/tmb-releases/releases/download/dev/install.sh \| TMB_CHANNEL=rc sh` |
| stable | Releases, tagged `vX.Y.Z`. | `curl -fsSL https://github.com/trustmybot/tmb-releases/releases/download/dev/install.sh \| TMB_CHANNEL=stable sh` |

On Windows, set `$env:TMB_CHANNEL` before running the PowerShell command, with `install.ps1` in place of `install.sh`.

tmb keeps itself up to date on its channel. When a session starts, tmb looks for a newer build there, at most once an hour, downloads it in the background, checks it against the published checksums and keeps it. It swaps the new build in only when a session ends and no other tmb session is running, so no session ever runs on two versions. An open task does not hold it back, since a task can stay open for days; a build that changes the record's layout upgrades it at the next start. Until then it keeps running the version it has, and with no network it simply runs that version.

| Command | Does |
|---|---|
| `tmb update` | Look for a newer build now and install it when no tmb session is running; otherwise keep it for the next swap and say so |
| `tmb update --check` | Only say whether a newer build is out |

Set `TMB_NO_UPDATE=1` to turn updates off. tmb keeps the kept build, the time of the last look and its session markers in `~/.local/state/tmb` (`$XDG_STATE_HOME/tmb` when that is set; Windows: `%LOCALAPPDATA%\tmb`). A tmb run from source never updates itself.

Earlier builds installed to `~/.tmb/bin` (Windows: `%LOCALAPPDATA%\tmb\bin`). The script removes that old copy; run `tmb setup` again in any project you set up with it.

`tmb --version` prints the version and the source commit it was built from. Dev builds print a version of the form `X.Y.Z-dev.<n>.gh<PR>`, where `<n>` counts the commits since the last stable release and `<PR>` is the pull request that brought in the build's commit.

## Set up a project

In the project's root folder:

```sh
tmb setup
```

Setup first looks for the hosts tmb supports, today Claude Code. With none installed it stops, names the hosts it supports and changes nothing. With one installed it says which and uses it; with several it asks which to use.

It then wires tmb into that host, as listed below, and asks three questions:

| Question | Default | Flag |
|---|---|---|
| The base branch, the branch pull requests merge into | The branch origin names as its default, else the current branch, else `main`. Outside a git repository there is no default. | `--base <branch>` |
| The review mode | `agile`, the only mode built so far. `truest` is refused: it arrives at level 10. | `--review-mode <mode>` |
| The checks, the shell commands that must pass before a task closes | The commands it finds in the project: the `lint`, `typecheck` and `test` scripts of `package.json`, run with bun, npm, pnpm or yarn as the lockfile shows; `pytest` for a Python project; `cargo test` for Rust; `go test ./...` for Go. | `--check <command>`, once per command; the commands given replace the list |

- On a re-run, each default is the answer stored last time.
- A flag answers its question without asking. `--host <id>` picks the host the same way, and `--yes` takes the default of every question no flag answers.
- Setup asks only when it runs in a terminal. Without one, it takes the defaults and prints each value, so it never waits for input.

It stores the answers in the record. Each change to a setting is kept as an entry in the record's audit trail, and the newest entry is the value in force. Setup prints the settings it stored, and `tmb config` shows them later.

Setup also:

- Creates the project's record, `.tmb/trajectory.db`, which holds issues, notes and decisions.
- Registers tmb's tool server in the project's `.mcp.json` as `tmb`, keeping any other servers. It enables the server in `.claude/settings.local.json` so Claude Code loads it without asking.
- Adds three hooks to `.claude/settings.local.json`, the project settings file that is yours alone, and keeps everything else in that file:
  - A SessionStart hook runs `tmb hook session-start`, which starts each session with the planner role and the open work from the record.
  - A PreToolUse hook runs `tmb hook pre-tool-use` before Claude Code writes or edits a file, runs a shell command or starts a subagent.
  - A SubagentStop hook runs `tmb hook subagent-stop` when a subagent ends.
- Writes two agent files in `.claude/agents/`, marked as tmb's: `worker.md`, the worker that carries out one task, and `reviewer.md`, the reviewer that judges a finished change. The reviewer gets no tool that edits files. Both get tmb's tools.
- Never overwrites an agent file in `.claude/agents/` that tmb did not write.
- In a git work tree, adds `.tmb/` and `.claude/settings.local.json` to `.gitignore`. It also adds `.mcp.json` if setup created that file.

Running setup again with the same answers changes no file and records nothing.

Once the project is set up:

- tmb records each file write, shell command, subagent start and subagent end that the hooks report.
- tmb refuses file writes, shell commands and subagent starts, saying why, while it cannot read the record or the record was made by a newer tmb.
- tmb lets a worker start only when its start prompt names an open task as `task_id=<id>` and that task's worktree exists. It records the worker's run from its start to its end.
- When tmb allows an action it says nothing, so Claude Code still asks you for permission as it would without tmb.

## Unattended runs

When no one can answer during a run, such as in CI, a scheduled job or an agent test, start it with `TMB_UNATTENDED=1` set, for example `TMB_UNATTENDED=1 claude -p "<prompt>"`. Each session it starts is told that no one can answer, so the planner applies its defaults, names each default it used, and stops with the reason when a default is not safe. Only the value `1` turns this on. Nothing is stored in the project, so your next session is a normal one, and tmb allows and refuses actions exactly as in a normal session.

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
| `tmb config` | Show the project's settings: host, base branch, review mode and checks, one per line. In a project where setup has not run, it says so. |
| `tmb feature start <name>` | Start a feature branch: tmb cuts it from the latest commit of the base branch, without checking it out anywhere, and records it. It refuses a name git does not accept as a branch name, a name starting with `-` or under `tmb/`, a branch that already exists, and a project where setup has not set a base branch. |
| `tmb feature list` | List the feature branches, each with the base branch and commit it was cut from, its state and the ids of its tasks |
| `tmb task start <issue-id> --kind code\|docs [--feature <name>] --intent <text> --file <path>... --criterion <text>... [--check <command>]...` | Start a task on an open issue. `--kind` says who writes it: `code` for a worker, `docs` for the planner. tmb cuts the branch `tmb/<short id>`, named after the last eight characters of the task id, from the tip of the feature branch, and adds its worktree under `.tmb/worktrees/`. Without `--feature` it uses the only open feature branch, and refuses when none or several are open. It also refuses when setup has not set a base branch, or when a file overlaps one held by another open task. |
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

tmb finds the plugin's database (`.claude/tmb/trajectory.db` in the folder or one above it; `--from <path>` names another), and copies the records of one repo into this project's new record: its issues with their notes and decisions, its tasks with their branches and commits, their reviews, check runs and agent runs. Each copied record keeps its original time. When the plugin served several repos, tmb picks the one named like this folder; `--repo <name>` names another. The plugin's database is only read and stays unchanged, so the plugin keeps working.

The plugin's own features that tmb does not carry over stay behind: its audit log, world model, roundtables, cheatcodes, lanes, embeddings, session handoffs and pull request records. tmb refuses a plugin database of another schema version than 76, and a project whose record already holds issues or tasks, so it runs once. Run `tmb setup` afterwards if you have not.

## Remove

```sh
tmb remove
```

It removes only what setup added:

- The three hooks, keeping your own hooks and settings.
- The agent files tmb wrote in `.claude/agents/`, keeping any you wrote.
- The tool server's entry and its enabled line.
- `.mcp.json` itself, only if setup created that file and nothing else is left in it.

It keeps the record in `.tmb/`, because that is your data; delete the folder yourself to drop it. It does not remove the `.gitignore` lines.
