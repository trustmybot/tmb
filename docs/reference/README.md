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
| `tmb task start <issue-id> --intent <text> --file <path>... --criterion <text>... [--check <command>]...` | Start a task on an open issue. tmb cuts the branch `tmb/<short id>`, named after the last eight characters of the task id, from the tip of the base branch, and adds its worktree under `.tmb/worktrees/`. It refuses when setup has not set a base branch, or when a file overlaps one held by another open task. |
| `tmb task list` | List the open tasks |
| `tmb task brief <id>` | Show a task's spec, branch, worktree and the checks that run when it closes |
| `tmb task close <id>` | Run the checks on the task's commit, and close the task when they all pass |

Add `--json` to any of them for JSON output. A change you make here is recorded as yours, and one made through the tools names the agent's role and host.

A task closes only when its worktree has no uncommitted changes and has at least one commit past the point it was cut from. tmb then runs the project's checks, followed by the task's own, one after another in the worktree. Each check gets 10 minutes. Every run is recorded with its start, its end, each command's exit code and the end of its output. If a check fails, the task stays open, and tmb names the command and shows the end of its output. A task with no checks at all never closes.

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
