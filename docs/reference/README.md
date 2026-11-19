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

It asks no questions. Setup:

- Creates the project's record, `.tmb/trajectory.db`, which holds issues, notes and decisions.
- Registers tmb's tool server in the project's `.mcp.json` as `tmb`, keeping any other servers. It enables the server in `.claude/settings.local.json` so Claude Code loads it without asking.
- Adds three hooks to `.claude/settings.local.json`, the project settings file that is yours alone, and keeps everything else in that file:
  - A SessionStart hook runs `tmb hook session-start`, which starts each session with the planner role and the open work from the record.
  - A PreToolUse hook runs `tmb hook pre-tool-use` before Claude Code writes or edits a file, runs a shell command or starts a subagent.
  - A SubagentStop hook runs `tmb hook subagent-stop` when a subagent ends.
- Writes one agent file in `.claude/agents/` for each subagent role tmb defines, marked as tmb's. tmb defines no subagent roles yet, so today it writes none.
- Never overwrites an agent file in `.claude/agents/` that tmb did not write.
- In a git work tree, adds `.tmb/` and `.claude/settings.local.json` to `.gitignore`. It also adds `.mcp.json` if setup created that file.

Running setup again changes nothing.

Once the project is set up:

- tmb records each file write, shell command, subagent start and subagent end that the hooks report.
- tmb refuses file writes, shell commands and subagent starts, saying why, while it cannot read the record or the record was made by a newer tmb.
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

Add `--json` to any of them for JSON output. A change you make here is recorded as yours, and one made through the tools names the agent's role and host.

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
