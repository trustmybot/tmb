# Install, upgrade and session start

Every case of flow 1.1 in [FLOWS.md](FLOWS.md): how tmb gets onto a machine and into a project, how an update lands, what each session start does, and how to tell what broke. The commands a user types are in the [reference](../reference/README.md).

tmb is one compiled program per platform, not a plugin of any host. It holds the engine, the command line, the tool server, the dashboard's pages and every host adapter ([HOSTS.md](HOSTS.md)). Nothing else has to be installed first: no Node, no package install. tmb is one program for the whole machine; only the record and the host wiring are per project.

```mermaid
flowchart TD
    A[Human runs the installer script] --> B{Download matches its checksum?}
    B -- no --> X1[Nothing is installed]
    B -- yes --> C[Program lands under its channel's name]
    C --> D[Human runs init in the project]
    D --> E{A host tmb knows is installed?}
    E -- no --> X2[Stops, names the hosts, changes nothing]
    E -- yes --> F[Record created, host wired, push hook added, code graph indexed]
    F --> G[Human opens the host in the project]
    G --> H[Session start: the role and the open work]
    H --> I{Record readable?}
    I -- no --> X3[The session goes on and the gates deny until it is fixed]
    I -- yes --> J{Settings empty?}
    J -- yes --> K[2.1 First contact]
    J -- no --> L[Normal planner turn]
```

## Install: one program, three channels

The installer script is the only supported way to install. It needs no login, checks the download against the published checksums and refuses on a mismatch.

| Channel | Program | Holds |
|---|---|---|
| stable | `tmb` | Releases, tagged `vX.Y.Z`. |
| rc | `tmb-rc` | Release candidates, tagged `vX.Y.Z-rc.N`. |
| dev | `tmb-dev` | Every merge to the base branch, as one rolling prerelease. |
| one release | `tmb-<version>` | One rc or stable release. It never updates itself. |

- **Channels live side by side.** Each program updates only from its own channel and keeps its machine-wide state in a folder of its own name, so one never swaps another. `TMB_CHANNEL` picks the channel at install, `TMB_INSTALL_VERSION` pins one release.
- **A version names its channel:** `X.Y.Z-dev.N`, `X.Y.Z-rc.N` or `X.Y.Z`. A `tmb` whose version names dev or rc follows that channel.
- **A project runs the program that initialised it.** Its host events, its tool server and git's push hook call that program. Running another program's `init` moves the project, in either direction, whenever that program can read the record. The record's audit trail keeps every move.
- **Every printed command names the running program:** a project set up by `tmb-dev` is told to run `tmb-dev init`. A test builds tmb as `tmb-dev` and fails on any printed `tmb <command>` (trustmybot/tmb#268).
- **Releases are plain downloads.** Release files go to one public repo, separate from the source repo. Each release carries a `VERSION` file and its checksums. dev is published on every push to the base branch; rc and stable only when their tag is pushed. The source repo's README offers stable only and links to the release repo for rc and dev.
- **The packaging test comes first.** One compiled file must run on all three platforms with no network, open the record, parse code and answer a tool call from a host.

### What init writes

`tmb init` asks nothing and never waits for input, on a terminal or not (trustmybot/tmb#162). It finds the installed host and has its adapter wire tmb in. It leaves tmb's settings empty and ends by saying so and how they get filled ([ONBOARD.md](ONBOARD.md)).

| Init writes | Where |
|---|---|
| The record | `.tmb/` in the project |
| The tool server's registration, the event wiring and the role files | The host's own project files, through its adapter ([HOSTS.md](HOSTS.md)) |
| git's pre-push hook | Each repo tmb works in |
| The code graph | `.tmb/`, one graph per repo |
| Ignore lines for the above | `.gitignore` |

- **Run again, init replaces only what tmb wrote** and takes out what this version does not wire: role files for roles it does not have, and hooks under an event it does not use. The Human's own entries stay.
- **Files marked as written by `tmb setup` are recognised as tmb's** (trustmybot/tmb#89).
- **A plugin project's records are carried over by `tmb migrate`**, a one-way copy that leaves the plugin's database unchanged (trustmybot/tmb#17). A plugin project of several repos goes into one workspace record, each repo to the workspace repo of the same name or one the Human names. tmb never guesses a repo (trustmybot/tmb#193).

### Package managers

tmb's own installer and updater come first. The installer scripts stay; package managers are added beside them.

| Where | Route | Channels |
|---|---|---|
| macOS and Linux | tmb's own Homebrew tap, as a cask. On macOS it waits for notarization. | `tmb`, `tmb@rc` and `tmb@dev` |
| Windows | tmb's own Scoop bucket, then winget's community list | Scoop: `tmb`, `tmb-rc` and `tmb-dev`. winget: one package per channel. |
| Linux without Homebrew | The installer script | |

- **tmb keeps its own updater on every route.** The cask sets `auto_updates`, and the winget package refuses winget's own upgrade.
- **A manifest is a template in the source repo.** A release fills in its version and checksums, and pushes the cask to the tap and the Scoop manifest to the bucket. A release that is not the newest on its channel leaves them alone. The winget manifests are kept with the workflow run, for a submission.
- **A cask, not a formula.** A formula would not avoid the quarantine below, and Homebrew allows no formula name such as `tmb@dev`.
- **Planned (trustmybot/tmb#91):** the Human creates the tap, the bucket and their token, and submits to winget. While any of them is missing the publishing step skips and the release still succeeds.

## Operating systems

| OS | Builds | Installer | Notes |
|---|---|---|---|
| macOS | arm64, x64 | `install.sh` | Signed ad hoc; see macOS signing below |
| Linux | x64, arm64 | `install.sh` | |
| Windows | x64, native | `install.ps1` | git's hooks run under Git for Windows' own sh (trustmybot/tmb#221) |

After each release, CI runs the published installer on all three.

**macOS signing.** The macOS files are signed ad hoc. Homebrew marks what it downloads as quarantined, and macOS refuses to run a quarantined program that is only signed ad hoc: a Homebrew install on macOS installs, then does not run. So the installer script is the only route on macOS, and the tap says so. The script works because curl does not quarantine. Planned (trustmybot/tmb#91): the release workflow signs the macOS files with a Developer ID and has Apple notarize them.

**Offline.** The engine, the record, the code graph and the dashboard need no network. Whether the agents run offline depends on the host and its models.

## Upgrade

An install follows one channel and updates itself. A session that is running keeps the build it started with, so a task never meets a new build half way.

```mermaid
flowchart TD
    A[Session start] --> B{Looked within the hour, or updates off?}
    B -- yes --> R[Run the installed build]
    B -- no --> C[Look for a newer build on the channel, in the background]
    C --> D{Newer build that matches its checksum?}
    D -- "no, or no network" --> R
    D -- yes --> E[Keep it]
    E --> F[Installed at a session's end, or by the update command]
    F --> G{A session still running in a project?}
    G -- no --> K[The next open of the record upgrades it]
    G -- yes --> H[That session and its project keep their build]
    H --> I{Its next tool call, with no task open?}
    I -- no --> H
    I -- yes --> J[Its tool server moves to the new build and says so]
    J --> K
    K --> L{Next session start: no task open?}
    L -- yes --> M[Init's wiring is redone; hosts read it from the session after]
    L -- no --> N[Waits, and says so]
```

- **An update installs at once, whatever is running** (trustmybot/tmb#159): at a session's end or on `tmb update`. `tmb update --check` only looks. `TMB_NO_UPDATE=1` turns updates off. A tmb run from source never updates itself.
- **A running session keeps its build, and so does its project.** Every tmb call there runs that build: the host's events, the tool server, git's push hook, a command the Human types. So the record keeps its shape and the host files stay as they are until the session moves.
- **The session moves by itself**, once no task is open, and keeps its conversation. When the move fails it keeps its build and says how to reconnect the tool server in that host.
- **`tmb update` names each session still on an old build**, with its folder, title and start time, and why it waits.
- **An old build is never deleted by itself.** tmb says how many old builds no session uses and their size. `tmb doctor` lists them and deletes them on the Human's yes (trustmybot/tmb#160).
- **Version.** `tmb --version` prints the program's name, its version, its source commit and its channel.
- **Switch channels.** Install the other channel's program and run its `init` in the project. The record is per project, so data carries over.
- **The record follows the program** (trustmybot/tmb#128). A newer tmb that opens a record upgrades it by itself: every pending step in one transaction, so the record is never left between versions. An older tmb refuses a record a newer one reshaped, and names the program that wrote it and the command that moves on, never a version number (trustmybot/tmb#173). Such a project never holds this tmb's update back.
  - **No backup is taken before an upgrade.**
- **The host files follow at a session start.** When another version of the same program last wired the project, tmb redoes init's wiring: each host the project is set up for, and git's push hook.
  - It replaces only what tmb wrote, asks nothing and changes no setting. An older version refreshes as a newer one does, so the files match the program that runs.
  - Never while a task is open, and not for a project tied to another channel's program: moving a project stays the Human's `init`.
  - The record keeps each refresh as an audit entry: the program, from which version to which, the hosts and what changed.
  - A refresh that fails never stops the session. The line says what failed and names `init`.
- **Uninstall.** `tmb remove` undoes what init added and leaves the Human's own settings alone. It runs only on a terminal, after a typed yes. Three things stay: the record, which is the Human's data, the lines init added to `.gitignore`, and the repo from `git init` in a folder that had none.

## Session start

- **The role comes from the engine, every time.** The host raises its session start event, and the engine answers with the host's role, the open work from the record and the project's layout from the code graph. A host that raises the event again on resume, clear or compaction gets the same answer, so a session resumes from the record and needs nothing from the conversation before it. tmb never writes the host's own instruction file.
- **Never blocking.** A session start never fails. With a record it cannot read, it gives the role and one line naming the problem, and the gates deny until it is fixed ([HOSTS.md](HOSTS.md#gates-fail-closed)).
- **One line per finding.** The planner is told, in one line each: a host-file refresh, what `tmb doctor` would find ("N things need a look"), each pull request that ended since the last session, and a repo whose push gate is off. It runs only doctor's quick checks, asks git and not GitHub, and says nothing when there is nothing to say.
- **Empty settings start first contact** ([ONBOARD.md](ONBOARD.md)).
- **It tidies.** With no task open or in review, tmb tries again to remove the worktrees closed and dropped tasks kept.
- **Unattended runs.** A run with no one to answer is told so first ([HOSTS.md](HOSTS.md#unattended-mode)).
- **The push gate.** Init installs git's pre-push hook, not session start. There is no switch that turns it off; a repo marked exempt gets none. A repo whose pre-push hook is another tool's keeps that hook, and the gate is off there until the Human says yes to tmb's one line in it; init, every session start and `tmb doctor` name the repo until then (trustmybot/tmb#184).
- **Which record.** The nearest record in the session's folder or a folder above it.

## Bug reports

Flow 5.1. How to use it is in the [reference](../reference/README.md#report-a-bug-in-tmb).

```mermaid
flowchart TD
    A[tmb itself breaks, or the Human runs the feedback command] --> B{Feedback program on?}
    B -- "no, and the planner would offer" --> Z[No report offered]
    B -- yes, or the Human's own command --> C[Draft from the repo's bug form, cleaned of paths and secrets]
    C --> D[Human reads the whole report]
    D --> E{Yes?}
    E -- no --> Z2[Nothing is sent]
    E -- yes --> F{GitHub's CLI signed in?}
    F -- yes --> G[tmb files the issue from the Human's account]
    F -- no --> H[The bug form opens filled in; the Human submits]
    G --> I[The record keeps the report and its link]
    H --> I2[The record keeps that a form was opened]
```

- **Nothing is sent by itself, on any channel.** The Human says yes to each report.
- **On by default on dev and rc, asked about on stable**, once, at the first run. The setting belongs to the person: it is kept with the machine-wide state of each channel's program.
- **A report is an issue on the source repo, from the user's own GitHub account.** A link is kept under 7,500 characters; a longer report is saved to a file to attach.
- **A report follows the repo's bug form** as it stands on the default branch, so the version, the labels and the questions are always current ([contributing](../contributing/README.md#issues)). With no network it uses a built-in copy, which the build takes from the same form file.
- **Labels come from the form on both routes.** GitHub drops the labels of an issue filed through its API by someone who cannot write to the repo. So a report filed through the CLI carries one hidden line, `<!-- tmb-feedback form=bug.yml -->`, and a workflow on the repo adds that form's labels.
- **A report holds no source code, file contents, prompts, agent messages or environment variables.**
- **For an opened form the record cannot know whether the user pressed submit.**

## Debugging

`tmb doctor` checks the machine and the project and names the fix for each finding. It only reads; `--fix` asks before each change.

| Symptom | Cause | Fix |
|---|---|---|
| `tmb: command not found` after install | The install folder is not on PATH in this terminal | Open a new terminal, or add the line the installer printed |
| `tmb init` stops and names the hosts it supports | No host tmb knows is installed | Install one; with several installed, `--host <id>` picks |
| No role, tools or events in a session | Init has not run here, the session started before init, or the worktree is one the host files do not wire | `tmb init`, then start a new session; `tmb doctor` lists unwired worktrees |
| Writes and agent starts denied: `tmb cannot read the project's record, so it allows nothing` | The record is damaged, empty, or not a tmb database | `tmb doctor --fix` repairs it on a yes and keeps the damaged file beside it |
| `has schema version N, made by a newer tmb` | Another program, or a newer build, reshaped the record | Run the program the message names, or `tmb update` |
| `task_start` is refused: no review mode | The review mode is the Human's choice and none is set | Answer the planner's question, or `tmb onboard` on a terminal |
| Session start says the push gate is off in a repo | The repo's pre-push hook is another tool's, or the record names none of the folder's repos | `tmb onboard --add-push-gate`; or `tmb init` again in the project folder |
| Host files are still an older version's | A task is open, so the refresh waits | Close or drop the task; the next session start refreshes |
| A session stays on an old build | A task is open in its project, or the move failed | `tmb update` says which and why; reconnect the tool server as the session says (in Claude Code: `/mcp`, then Reconnect on tmb) |
| A Homebrew install on macOS does not run | The build is not notarized | Use the installer script |
| A tmb check fails by itself | It looks like tmb's own bug | `tmb feedback` drafts a report |
