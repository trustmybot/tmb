# Reference

What a user types and what comes back: install, setup and every command. The design behind them is in [architecture/](../architecture/README.md) and [flows/](../flows/README.md).

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

The script:

- Downloads the file for your platform, checks it against the published checksums and refuses to install on a mismatch.
- Puts the program in `~/.local/bin` (Windows: `%USERPROFILE%\.local\bin`), the folder Claude Code also installs to, under its channel's name ([Channels and updates](#channels-and-updates)).
- Adds that folder to your shell profile (Windows: your user PATH) when it is not on your PATH, and says where; open a new terminal afterwards. With `TMB_NO_MODIFY_PATH=1` it prints the line to add instead.
- Removes a copy it finds in `~/.tmb/bin` (Windows: `%LOCALAPPDATA%\tmb\bin`), and names the program to run `init` with again, such as `tmb-dev`, in any project set up with that copy.

Run the same command again to upgrade.

## Channels and updates

Each channel installs as a program of its own name, so channels and versions live side by side on one machine. Pick the channel with `TMB_CHANNEL`, or one exact release with `TMB_INSTALL_VERSION`, when you install:

| Program | Follows | Install |
|---|---|---|
| `tmb-dev` | dev (default): a build of every merge to the base branch. | The commands above. |
| `tmb-rc` | rc: release candidates, tagged `vX.Y.Z-rc.N`. | `curl -fsSL https://github.com/trustmybot/tmb-releases/releases/download/dev/install.sh \| TMB_CHANNEL=rc sh` |
| `tmb` | stable: releases, tagged `vX.Y.Z`. | `curl -fsSL https://github.com/trustmybot/tmb-releases/releases/download/dev/install.sh \| TMB_CHANNEL=stable sh` |
| `tmb-<version>` | One rc or stable release. It never updates itself. | `curl -fsSL https://github.com/trustmybot/tmb-releases/releases/download/dev/install.sh \| TMB_INSTALL_VERSION=1.0.0 sh` |

On Windows, set `$env:TMB_CHANNEL` or `$env:TMB_INSTALL_VERSION` before running the PowerShell command, with `install.ps1` in place of `install.sh`.

The examples on this page say `tmb`; use the name of the program you installed.

- **A project runs the program that initialised it.** Its hooks, its tool server and git's push hook call that program, so a project initialised with `tmb-dev` always runs dev. To move a project to another program, run that program's `init` in it.
- **A program refuses a project whose record a newer tmb has reshaped,** and names the program that did. Run that one there, or update this program with its `update` command; a program pinned to one release names the installer command instead.
- **A `tmb` whose version names dev or rc keeps following that channel.** The installer points it out when it installs the channel's own name.

| Command | Does |
|---|---|
| `tmb update` | Look for a newer build now and install it at once. It names each session still on an old build by its folder, title and start time, and why |
| `tmb update --check` | Only say whether a newer build is out |
| `tmb --version` | Print the program's name, its version, the source commit it was built from and the channel it follows. A dev build's version is `X.Y.Z-dev.<n>.gh<PR>`: `<n>` counts the commits since the last stable release and `<PR>` is the pull request that brought in the build's commit |

Each program keeps itself up to date on its own channel ([1_INSTALL.md](../flows/1_INSTALL.md) has the steps):

- **A look at session start,** at most once an hour. A newer build is downloaded in the background and checked against the published checksums. `tmb update`, or the end of any session, installs it at once. With no network tmb runs the version it has.
- **A running session keeps its build** until its next tool call with no task open in the project. It then moves by itself and says so in one line; the conversation is kept. If the move fails, it says how to restart tmb's tool server (in Claude Code: `/mcp`, then Reconnect on tmb).
- **Old builds are kept.** tmb says how many no session uses and their size; [`tmb doctor`](#check-this-machine-and-project) deletes them on your yes.
- **Each project catches up by itself.** Its record is upgraded the first time tmb opens it. The files `tmb init` wrote are refreshed at the next session start with no task open, the session says so in one line, and they apply from the session after. If a refresh fails, the session goes on and the line names `tmb init`. A project set up with another channel's program is left alone.
- **`TMB_NO_UPDATE=1` turns updates off.** A tmb run from source never updates itself.
- **Each program has a state folder of its own name,** such as `~/.local/state/tmb-dev` (`$XDG_STATE_HOME/tmb-dev` when that is set; Windows: `%LOCALAPPDATA%\tmb-dev`), so one never swaps another.

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

| Command | Does | Asks questions |
|---|---|---|
| `tmb init` | Prepares the project: creates its record, wires the host, adds git's push hook and indexes the code graph. It leaves tmb's other settings empty. | None |
| `tmb onboard` | Sets tmb's settings for the project: a host's role, the base branch, the review mode and the checks; in a multi-repo workspace, each repo's base branch and checks. Run it again at any time. | Yes |
| `tmb remove` | Undoes what `tmb init` added ([Remove](#remove)). | No |

At the first session the planner fills the settings init left empty ([Onboarding by itself](#onboarding-by-itself)) and asks you for the review mode ([The review mode is yours](#the-review-mode-is-yours)). `tmb onboard` sets them yourself instead.

### init

`tmb init` asks nothing and never waits for input, on a terminal or not.

- **It looks for the hosts tmb supports,** today Claude Code. With none installed it stops, names the hosts it supports and changes nothing. With one installed it says which and uses it. With several it takes the one stored by an earlier init, else the first, and says so; `--host <id>` picks one. Run it once per host to use two hosts on one record.
- **It wires tmb into that host** ([Settings](#settings) lists what it writes) and stores the host and its role, `planner` unless `--role reviewer` is given. It takes no other flag and sets no other setting: a setting stored before is kept, and the rest stay empty.
- **It ends by printing the settings and the next steps:** the command that starts the host in this folder and, for a planner, what to send first. A host set up as the reviewer gets one step, since it starts as the reviewer. The last line says which settings are still empty and how they get filled, or, with every setting stored, how to change them; it names the program to run `onboard` with, such as `tmb-dev`. With no review mode stored, it says that none is chosen, how to choose it, and that no task starts until it is. The commands are coloured as in [Help and mistyped commands](#help-and-mistyped-commands).
- **Run again, it replaces what an earlier tmb wrote** and takes out what this version no longer uses: tmb's role files for roles that no longer exist, and tmb's hooks under an event they no longer use. Your own entries stay.

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
- The review mode has no default. `--review-mode` is a [step only you may take](#steps-only-you-may-take): it asks you to type yes on the terminal, also when `--yes` is given. Without a terminal it is refused, unless unattended mode is on for the run (`TMB_UNATTENDED=1`), as in CI, and no review mode is set yet: unattended mode sets one, never changes one. Without the flag and with no terminal, the review mode stays as it is and onboard says so.
- In a project where `tmb init` has not run, it says so and changes nothing.

### One repo or a workspace of several

The folder you run `tmb init` in decides the project's shape ([One record, one or several repos](../flows/3_GIT.md#multi-repo-workspaces)):

| The folder | The project |
|---|---|
| Is a git work tree, or inside one | One repo, the folder itself, named `.` |
| Is in no git work tree and holds no git repo | One repo: init runs `git init` in it and says so, before it writes anything, so `.gitignore` gets init's lines on the first run |
| Is not a git work tree but holds git repos | A workspace: its repos share one record in that folder |

In a workspace init also:

- Finds the repos up to two folders down and stores them in the `repos` setting, each with the base branch its own git points at and the checks found in it. It records each top-level folder that is not a repo as `{"git": false}`, and leaves it alone. It prints a line for each repo or folder it added, with where a base branch came from, and for each one it dropped because it is gone. A repo's policy set before is kept.
- Writes git's pre-push hook into each repo that is not exempt, and `tmb remove` deletes each. The hook is shared by every worktree of that repo, so a session already working there meets the gate at its next push.
- Indexes each repo's code graph from its own base branch.

**A record that names no repos, in a folder that holds several.** Run `tmb init` there again: it finds and stores them as above. Until then `tmb onboard --repo` is refused, `tmb index` is refused and names the repos it found, and no push is gated. `tmb doctor` and the planner's session start say that the gate is off.

`tmb onboard --repo <name>` sets one repo:

| Flag | Sets |
|---|---|
| `--base <branch>`, `--check <command>` | The repo's base branch and checks |
| `--exempt` | tmb does no work in the repo |
| `--review-mode <mode>` | A review mode of the repo's own. A [step only you may take](#steps-only-you-may-take), as the workspace's is; refused in unattended mode |
| `--review-mode workspace` | Takes the repo's own mode away, so it follows the workspace's again |

- With one repo tmb works in, `--repo` may be left out.
- On a terminal without `--repo`, onboard asks for each repo's base branch and checks in turn. It asks for the workspace's review mode once, then asks once whether any repo takes its own, and asks each repo only on a yes.
- The planner sets the same with `settings_set` and `repos`. A repo it names keeps no part of its old policy except its review mode, which stays unless the planner names one or `workspace`. Repos it does not name keep theirs.
- `base_branch` and `checks` are not used in a multi-repo workspace: each repo has its own in `repos`, and `settings_set` refuses them.
- `tmb feature start <name> --repo <name>` and `tmb task start ... --repo <name>` name the repo; with several repos, one that names none is refused with the list.
- Each repo works in its own review mode: `tmb feature start` is refused in a repo in truest mode, and a task there goes into review at close. `tmb config` and the session start show each repo's mode.

### Onboarding by itself

When a planner's session starts and the base branch, the review mode or the checks is empty, the planner fills them before other work ([2_ONBOARD.md](../flows/2_ONBOARD.md)):

- **It applies the base branch and the checks it recommends** and shows them. It reminds you that `tmb onboard` can be run again and that it can change a value when you ask. In an unattended run it names each value it applied.
- **It never applies the review mode.** It asks you with the host's question tool (AskUserQuestion in Claude Code), showing each mode with what it costs and marking agile as recommended, and stores your answer.

`settings_get` reads the settings and what tmb found; `settings_set` is the planner's alone.

### The review mode is yours

The review mode decides how many tokens a project uses, so tmb recommends one and never picks it. While none is set, tmb refuses to start a task and says how to choose. There are three ways:

- answer the planner's onboarding question at the first session. It stores your answer;
- run `tmb onboard` on a terminal;
- run `tmb onboard --review-mode <mode>` on a terminal and type yes.

In an unattended run nobody can answer, so the task start is refused, the refusal names `tmb onboard`, and the planner cannot set or change the mode. Set it before the run. The record keeps which way the mode was chosen.

### Settings

The settings are kept in the record; the keys are in [CONFIG.md](../architecture/CONFIG.md). Init and onboard print the settings in force, and `tmb config` shows them later.

`tmb init` also:

- Creates the project's record, `.tmb/trajectory.db`, which holds issues, notes and decisions.
- Registers tmb's tool server in the project's `.mcp.json` as `tmb`, keeping any other servers. It enables the server in `.claude/settings.local.json` so Claude Code loads it without asking.
- Adds five hooks to `.claude/settings.local.json`, the project settings file that is yours alone, and keeps everything else in that file:
  - A SessionStart hook runs `tmb hook session-start`, which starts each session with the role this host was set up with, the planner unless you chose the reviewer, and the open work from the record.
  - A PreToolUse hook runs `tmb hook pre-tool-use` before Claude Code writes or edits a file, starts a subagent, or reads a task's brief or closes a task through tmb's tools. It also runs before a shell command, and denies one that runs a [step only you may take](#steps-only-you-may-take); tmb reads no other shell command, and git's pre-push hook checks every push.
  - A PostToolUseFailure hook runs `tmb hook post-tool-use-failure` when a subagent start fails after tmb allowed it, for example when Claude Code cannot make the worker's worktree. tmb ends the run that start opened, as stopped.
  - A SubagentStop hook runs `tmb hook subagent-stop` when a subagent ends.
  - A SessionEnd hook runs `tmb hook session-end` when the session ends.
- Writes two agent files in `.claude/agents/`, marked as tmb's: `worker.md`, the worker that carries out one task, and `reviewer.md`, the reviewer that judges a finished change. The reviewer gets no tool that edits files, and keeps its shell to run checks. Both get tmb's tools.
- Never overwrites an agent file in `.claude/agents/` that tmb did not write.
- In a git work tree, adds `.tmb/` and `.claude/settings.local.json` to `.gitignore`. It also adds `.mcp.json` if init created that file.
- In a git work tree, writes git's pre-push hook, so every push asks tmb first; in a multi-repo workspace, one in each repo tmb works in. A pre-push hook that is not tmb's is left alone, and init prints the line to add to it.
- Indexes the code graph of the base branch, once it has a commit; in a multi-repo workspace, each repo's from its own base branch.

Running init or onboard again with the same answers changes no file and records nothing.

Once the project is set up:

- tmb records each file write, subagent start and subagent end that the hooks report.
- tmb refuses file writes and subagent starts, saying why, while it cannot read the record or the record was made by a newer tmb. A record file that is there but empty counts as one it cannot read.
- tmb refuses every file write by the reviewer, through any of Claude Code's edit tools. tmb does not read shell commands, so a file the reviewer writes from its shell is not refused; git's pre-push hook still checks its pushes.
- tmb lets a worker start only when its start prompt names an open task as `task_id=<id>` and that task's worktree exists. It records the worker's run from its start to its end.
- When tmb allows an action it says nothing, so Claude Code still asks you for permission as it would without tmb.

## Unattended runs

When no one can answer during a run, such as in CI, a scheduled job or an agent test, start it with `TMB_UNATTENDED=1` set, for example `TMB_UNATTENDED=1 claude -p "<prompt>"`. Only the value `1` turns this on. The rules are in [ENGINE.md](../architecture/ENGINE.md).

- **The planner applies its defaults and names each one it used.** A recommended answer counts as the answer: the planner records it as a decision on the issue and goes on to start the feature branch and its first task. It stops only when no default is safe, and says why.
- **The review mode is never a default.** With none set, the run's first task is refused ([The review mode is yours](#the-review-mode-is-yours)).
- **Nothing is stored in the project,** so your next session is a normal one. tmb allows and refuses actions exactly as in a normal session.

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
| A downloaded update that has not applied, and why: how far behind the installed build is, in builds and in days, and which sessions hold it; a look for an update that failed | `tmb update` |
| Entries of sessions whose process ended | Removes them, on your yes |
| Files an update left when it stopped half-way | Removes them, on your yes |
| Other channels' programs installed side by side, each with its version | Shown only |
| The state folder can be read and written | The step that gives you access |

| In this project | Fix |
|---|---|
| The record: readable, its shape's version, and which program wrote it | Repairs a damaged record on your yes, keeping the damaged file beside it; for a newer shape, the program to use |
| The host files and git's pre-push hook match what this tmb wires | `tmb init --host <id>` |
| A project folder that is not a git repo and holds repos the record does not name: the push gate is off there, the repos are not set and no code graph can be built | `tmb init`, run again in the project folder |
| The program the project is tied to, and any running session that keeps it on an older build | Shown only |
| Empty settings, and the review mode not chosen | `tmb onboard` |
| Runs and checks with a start and no end, and open tasks no agent run is on | Shown only: the planner decides |
| Worktrees and branches of closed and dropped tasks still on disk | Removes each on your yes, by the same rules as closing a task: a worktree with work nobody committed stays |
| The code graph behind its base branch, built by an older indexer, or with files not parsed | `tmb index` |
| GitHub's CLI installed and signed in | `gh auth login` |
| Other records in a folder above the project or below it | Shown only |
| Work that went around tmb: since the record was made, the commits on each base branch that are not the record's own, as a count, a share and the newest one's date, and pull requests merged with no task where `gh` is signed in. A commit is the record's own when it, or a branch it merged, is a task's commit or a feature branch's, or it names a pull request the record opened. With no GitHub to ask it counts with git alone and says so; it reads at most 5000 commits per repo and says when it stopped | Shown only: a push typed by hand stays allowed |
| A plugin record beside this one that holds repos no migration brought here, with what each holds | `tmb migrate --repo <name>`; in a folder whose repos are not named yet, `tmb init` again first |
| Ended runs that carry no cost, as a count and a share; runs migrated from the plugin are included, and the line says so | Shown only |
| Tasks that name no repo in a multi-repo workspace, made before the project became one | `tmb init` again |
| Worktrees of the project's repos, wherever they sit, that the host's files do not wire, so a session there runs without tmb's hooks or tool server: a count and the first few. A repo's main folder and a task's worktree are left out | Shown only |

- **It never deletes without your yes**, and never touches a file tmb did not write.
- **It runs with a broken record.** Every check that does not need the record still runs, and the ones that do say why they were skipped. A record an older tmb wrote is upgraded by the next tmb command, not by doctor.
- **A check that fails by itself looks like tmb's own bug.** Its line says so and names `tmb feedback`, which can put that error in a report.
- **The planner's session start names what doctor finds**, in one line: "N things need a look: `tmb doctor`". When the record names none of the repos in a folder of repos, the line says first that the push gate is off. It runs only the quick checks, asks git and not GitHub, and says nothing when there is nothing to say.

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

The planner records work through tmb's tools. You can read and change the same record yourself, from the project folder or any folder below it, such as one repo of a workspace. The flows behind these commands are in [3_TASKS.md](../flows/3_TASKS.md), [3_WORKFLOW.md](../flows/3_WORKFLOW.md) and [3_GIT.md](../flows/3_GIT.md).

| Command | Does |
|---|---|
| `tmb issue create <title> [--body <text>] [--milestone <name>]` | Record a new issue |
| `tmb issue list [--state open\|closed]` | List issues |
| `tmb issue show <id>` | Show an issue with its notes and decisions |
| `tmb issue close <id>`, `tmb issue reopen <id>` | Close or reopen an issue |
| `tmb note <issue-id> <text> [--decision]` | Add a note, or a decision with `--decision` |
| `tmb search <query>` | Search issues, notes and decisions |
| `tmb history <id>` | Show every recorded change to an issue or note |
| `tmb config` | Show the project's settings: host, each host's role, base branch, review mode, checks and, in a multi-repo workspace, the repos, one per line. In a project where `tmb init` has not run, it says so. |
| `tmb feature start <name>` | Start a feature branch, cut from the latest commit of the base branch on `origin`, fetched first, and checked out nowhere. tmb cuts from your local base branch when that holds a commit `origin` lacks, when there is no `origin`, or when `origin` is out of reach. Refused: a name git does not accept as a branch name, a name starting with `-` or under `tmb/`, a branch that already exists, a project with no base branch set, and truest mode, where a task is cut from the base branch. In a multi-repo workspace, `--repo <name>` names the repo. |
| `tmb feature list` | List the feature branches, each with the base branch and commit it was cut from, its state and the ids of its tasks. A branch whose pull request is open is checked on GitHub first, through `gh`: `merged` once the pull request merged, `closed` when it closed without a merge. A `ready` branch (a repo with no remote) shows as `merged` once the local base branch holds its work: merged, squashed or rebased onto it by hand. Its line says how to end it when tmb cannot see its merge. |
| `tmb task start <issue-id> --kind code\|docs [--feature <name>] --intent <text> --file <path>... --criterion <text>... [--check <command>]...` | Start a task on an open issue. `--kind` says who writes it: `code` for a worker, `docs` for the planner. tmb cuts the branch `tmb/<short id>`, named after the last eight characters of the task id, from the tip of the feature branch, and adds its worktree under `.tmb/worktrees/`. Without `--feature` it uses the only open feature branch. `--feature` can also name a branch whose pull request is open, for a fix, a closed branch, or one ready for a local merge (a repo with no remote), which opens it again. Refused: no open feature branch or several with no `--feature`, a merged branch, no base branch set, no review mode chosen. When a file is also in another open task's spec, the task still starts and tmb names the tasks that share it. In truest mode the task is cut from the base branch and `--feature` is refused. In a multi-repo workspace, `--repo <name>` names the repo. `--replaces <id>` names the dropped task whose work this one takes up another way; it is refused for a task that is not dropped. |
| `tmb task list [--state open\|in_review\|ready\|closed\|dropped\|all]` | List the open tasks, or those in review, the ready ones (waiting for the Human's local merge in a repo with no remote), the closed ones, each with the commit it closed at, the dropped ones, or all |
| `tmb task brief <id>` | Show a task's kind, feature branch, spec, branch, worktree and the checks that run when it closes |
| `tmb task close <id>` | Run the checks on the task's commit; when they all pass, close the task, fold it into its feature branch and push that branch to `origin` ([Closing a task](#closing-a-task)). While the feature branch's pull request is open the push is left out, and tmb says so: the new tip reaches the pull request through `tmb feature pr`, after its review. In truest mode the task is not folded: it goes into review at that commit. |
| `tmb feature update <name>` | Bring the base branch into a feature branch before its review: tmb fetches the base, merges it in with a merge commit and pushes the branch as a backup. While the branch's pull request is open the push is left out, as for `tmb task close`. A conflict changes nothing and names the files. A merged branch is refused. |
| `tmb feature brief <name>` | Show a feature branch's tip, its tasks, reviews and waivers |
| `tmb feature waive <name> --reason <text>` | Waive the review of a feature branch at its tip. The Human only, on a terminal: it asks you to type yes. |
| `tmb feature pr <name> --title <text> [--body <text>]` | Open the feature branch's pull request into the base branch, once the reviewer passed its tip or you waived the review. When the pull request is already open, it pushes the reviewed tip to it and returns the same pull request. On a closed branch it opens a new one, or records the one already open from the branch. In a repo with no remote nothing is pushed: the branch is recorded ready and tmb prints the command to merge it locally, and how to end the branch with `tmb feature drop` if its work reaches the base branch in a way tmb cannot see. A merged or dropped branch is refused. |
| `tmb feature drop <name> --reason <text>` | End a feature branch without a merge tmb saw: one nobody will merge, or one whose work reached the base branch another way (say where in the reason). An open, closed or ready branch is dropped; one whose pull request is open is refused, so close the pull request first. Refused while a task on it is open or in review. The branch is recorded as dropped with the reason and kept in git; tmb names the command that deletes it. A dropped branch takes no task and opens no pull request. The planner may drop one too. |
| `tmb task drop <id> --reason <text>` | End an open task, or a truest task in review, without its work. The task is recorded as dropped with the reason. Its worktree is removed by the rules for a closed task ([Closing a task](#closing-a-task)); its branch is kept while it holds commits, and tmb names it and the command that deletes it. |
| `tmb task waive <id> --reason <text>` | Waive the review of a truest task at its commit. The Human only, on a terminal: it asks you to type yes. |
| `tmb task pr <id> --title <text> [--body <text>]` | Open a truest task's pull request into the base branch, once the reviewer passed it or you waived the review. In a repo with no remote nothing is pushed: the task is recorded ready and tmb prints the command to merge its branch locally |
| `tmb graph map\|find\|symbol\|scope\|concepts\|areas` | Look things up in the code graph ([Code graph lookups](#code-graph-lookups)) |
| `tmb index [--rebuild]` | Bring the code graph up to date, or build it again from nothing. It prints how many files could not be parsed and how many imports of the repo's own code link to no file |
| `tmb dashboard [--port <n>] [--project <dir>]` | Open the dashboard, a local web page over the record |

Add `--json` to any of them for JSON output. A change you make here is recorded as yours, and one made through the tools names the agent's role and host.

### Code graph lookups

`tmb graph` reads the project's files with their summaries (`map`), where a name lives (`find`), what calls it (`symbol`), a draft of a task's files (`scope`), the recorded concepts (`concepts`), and the project's areas with the files in no area (`areas`).

| Flag | Does |
|---|---|
| `--area <name>` | On `find` and `scope`: stay inside one area and the areas nested in it. An unknown area is refused with the list of areas |
| `--skip-area <name>` | On `find` and `scope`: leave an area out, such as `tests`. It can be repeated |
| `--task <id>` | Read as that open task sees the code; a closed task's id reads its feature branch |
| `--feature <name>` | Read a feature branch at its tip, with the work already folded into it. Refused together with `--task` |
| `--repo <name>` | In a workspace of several repos: the repo whose graph to read. Left out, it is the repo whose folder the command runs in; in the workspace folder itself a lookup that names none is refused with the list of repos. A task or a feature branch reads its own repo |

With neither `--task` nor `--feature`, `scope` reads the repo's only open feature branch, and the base branch when several are open.

### Closing a task

`tmb task close` goes through these steps, and a refusal at any of them leaves the task open, the feature branch where it was and the worktree as it was. The design is in [3_WORKFLOW.md](../flows/3_WORKFLOW.md) and [3_GIT.md](../flows/3_GIT.md).

| Step | Refused when | tmb says |
|---|---|---|
| The commit | The worktree has uncommitted changes, or no commit past the point it was cut from | |
| The checks: the project's, then the task's own, one after another in the worktree, 10 minutes each | A check fails, or the task has no checks at all | The command, and the end of its output |
| The fold: the feature branch moves to the task's commit. If another task folded in first, tmb rebases the task onto the new tip and runs every check again on the rebased commit | The rebase conflicts, a check fails, or a checkout of the feature branch has uncommitted changes | The conflicting paths, or the failing command |
| The push of the feature branch to `origin`, never forced | Never: a failed push does not reopen the task | Whether the push went through, failed with git's message, or was skipped because there is no `origin` |

- Every check run is recorded with its start, its end, each command's exit code and the end of its output.
- If the feature branch is checked out somewhere, tmb moves it there too.
- The closed task records its kind, the review mode it was started in and the commit it folded.

What tmb does with a closed task's worktree depends on what is left in it:

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

### What a docs task may change

A docs task's close is refused, naming each file, when its change touches a file whose type is not below. A type not listed counts as code, so a change to it goes in a code task.

| Kind | Types |
|---|---|
| Prose | `.md` `.markdown` `.txt` `.rst` `.adoc` |
| Data | `.json` `.yaml` `.yml` `.toml` `.csv` `.tsv` |
| Images | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` |
| Files with no extension | `LICENSE` `NOTICE` `AUTHORS` `CHANGELOG` `README` `COPYING` |

The extension is the file's last one and the name is matched without regard to case, so `guide.MD` and `License` are allowed. A data file can still change behaviour, such as a CI file or a setting; the reviewer catches that.

## Move a plugin project

A project that used the [TMB plugin](https://github.com/trustmybot/plugin) can bring its records over. In the project's folder, init first, then migrate:

```sh
tmb init
tmb migrate
```

- **What it reads.** The plugin's database, `.claude/tmb/trajectory.db` in the folder or one above it; `--from <path>` names another. It is only read and stays unchanged, so the plugin keeps working.
- **What it copies.** The records of one repo, into the record `tmb init` made for this project, which it names: its issues with their notes and decisions, its tasks with their branches and commits, their reviews, check runs and agent runs. Each copied record keeps its original time.
- **Which repo.** When the plugin served several repos, tmb picks the one named like this folder; `--repo <name>` names another.
- **Unfinished tasks.** A task the plugin left unfinished stays open, and tmb holds its own updates while any task is open; `tmb migrate` says how many it left open.
- **What stays behind.** The plugin's audit log, world model, roundtables, cheatcodes, lanes, embeddings, session handoffs and pull request records; its discussion records of a kind tmb lacks (intent, question, answer and analysis; tmb keeps notes and decisions); and a task's plugin status beyond open or closed. tmb says how many records of each kind it left behind.
- **What it refuses.** A plugin database of another schema version than 76. In a single-repo project, a record that already holds issues or tasks, so it runs once. A project where `tmb init` has not made the record: it never creates one itself. A record in a folder above a repo that the record does not serve, which it names.

In a workspace of several repos ([One record, one or several repos](../flows/3_GIT.md#multi-repo-workspaces)), run `tmb migrate` in the workspace folder after `tmb init` there:

- Each plugin repo goes into the workspace's one record, to the workspace repo of the same name, and each copied task names that repo; issues name no repo.
- With no `--repo`, every plugin repo that maps is copied in one go, and tmb names each one it left out with the flag that maps it. `--repo <name>` copies one plugin repo, and `--repo <name> --into <workspace repo>` sends it to a repo of another name.
- tmb never guesses a repo, and refuses an exempt repo or a folder that is not a repo as the target.
- A plugin repo already migrated into the record is refused, so a re-run copies nothing twice. The plugin's issues of no repo are copied once, with the first migration.
- `tmb doctor` names each plugin repo no migration brought here, with what it holds, and the step that brings it.

A project of one repo whose folder later becomes a workspace keeps its tasks. `tmb init` run again gives each task that names no repo the one its migration from the plugin, its branch or its pull request shows, and says how many it gave and left, and each one given. Proofs that name different repos give none. The task's runs and checks follow it. A task nothing points to keeps no repo, and `tmb doctor` lists it.

## Remove

```sh
tmb remove
```

It removes only what `tmb init` added:

- The five hooks, keeping your own hooks and settings.
- The agent files tmb wrote in `.claude/agents/`, keeping any you wrote.
- The tool server's entry and its enabled line.
- `.mcp.json` itself, only if init created that file and nothing else is left in it.
- git's pre-push hook, if tmb wrote it.

It keeps the record in `.tmb/`, because that is your data; delete the folder yourself to drop it. It does not remove the `.gitignore` lines. It runs only on a terminal, once you type yes.

## Steps only you may take

Some commands are yours alone: `tmb feature waive`, `tmb task waive`, setting the review mode with `tmb onboard --review-mode`, and `tmb remove`. `tmb update` is not one. The rule is in [ENGINE.md](../architecture/ENGINE.md).

- Each runs only on a terminal, and asks you to type yes first. Anything else changes nothing.
- Without a terminal, as in an agent's shell, it is refused, does nothing and records nothing.
- A run that is yours with no terminal, such as CI, may set the review mode with `tmb onboard --review-mode <mode> --yes` when unattended mode is on for it (`TMB_UNATTENDED=1`), only while none is set. A mode you chose is changed only on a terminal, where you type yes.
