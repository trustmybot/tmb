# Distribution

How tmb is packaged, installed and updated.

## Package

One compiled file per platform: macOS, Windows and Linux. It contains the engine, the command line, the tool server, the dashboard's pages and every host adapter. Nothing else has to be installed first.

The packaging test runs at level 0 of the build: one compiled file that runs on all three platforms with no network, opens the database, parses code and answers a tool call from a host. If it fails, the language decision is reopened.

## Install

One step per platform. After it, two commands inside a project:

| Command | Does | Asks questions |
|---|---|---|
| `tmb init` | Finds the installed host and has its adapter register tmb's tools, roles and guards with it ([HOSTS.md](HOSTS.md)), creates the project's database, adds git's push hook and indexes the code graph. It leaves tmb's settings empty and ends by saying so and how they get filled. | None: it never asks or waits for input, on a terminal or not (trustmybot/tmb#162). The planner asks for the review mode at onboarding, and on the stable channel, once per machine, whether to join the feedback program |
| `tmb onboard` | Sets the project's settings: the base branch, the review mode, the checks to run, a host's role. It can be run again at any time. | Yes |

**Onboarding happens by itself.** When a session starts in a project whose settings are empty, the engine tells the planner. The planner works out the settings it recommends for that project, applies them through its `settings_set` tool and shows them, all but the review mode. It reminds the Human that `tmb onboard` can be run again at any time, and that the planner can change a value when asked. In an unattended run it does the same and names each value it applied; the review mode stays unset.

**The review mode is the Human's choice.** Decided by the Human on 2026-11-20 (trustmybot/tmb#114). The review mode decides how many tokens a project uses, so tmb recommends one but never picks it. No task starts until the Human has chosen: in the planner's onboarding questions at the first session, which show each mode with what it costs and mark agile as recommended, with `tmb onboard`, or with `tmb onboard --review-mode`. `tmb init` is non-interactive, as the Human decided on 2026-11-20 (trustmybot/tmb#162), so it never asks. With nobody to ask, the task start is refused, the refusal names `tmb onboard`, and the planner cannot set the mode. The record keeps which of the three ways chose it. The other settings stay the planner's recommendation.

Init and onboard replace the earlier `tmb setup`, which is gone (trustmybot/tmb#89). Files an earlier build marked as written by `tmb setup` are still recognised as tmb's, so init replaces them and remove deletes them.

**A project follows the program's updates.** Decided by the Human on 2026-11-20 (trustmybot/tmb#128). A newer tmb that opens a project's database upgrades it by itself. An older tmb refuses a record a newer one reshaped, and names the program that wrote it and the command that moves on, an update or the installer for a pinned build, never a version number (trustmybot/tmb#173). Such a project never holds this tmb's update back: no task there can run on it, and the update is what lets it read the record. The files init wrote follow at a session's start:

- **When another version of the same program last wired the project, tmb redoes init's wiring**: each host the project is set up for, and git's push hook. That replaces only what tmb wrote, asks nothing and changes no setting. An older version refreshes as a newer one does, so the files match the program that runs.
- **Never while a task is open.** tmb waits for a session start with none open, and says so.
- **Not for a project tied to another channel's program.** Moving a project stays the Human's `tmb init`.
- **The hosts read their files when a session starts**, so a refresh takes effect from the next session. The session start says so in one line, and in an unattended run the role names it in its answer.
- **The record keeps each refresh** as an audit entry: the program, from which version to which, the hosts and what changed. The project is then tied to the new version.
- **A refresh that fails never stops the session.** The line says what failed and names `tmb init`.
- **Init takes out what a version no longer wires**, as remove would: tmb's role files for roles that no longer exist, and tmb's hooks under an event they no longer use.

Removing tmb from a project (`tmb remove`) undoes what init added and leaves the Human's own settings alone. Two things stay: the lines init added to `.gitignore`, and the repo from `git init` in a folder that had none.

tmb is one program for the whole machine. Only the database and the host wiring are per project.

Decided by the Human on 2026-11-19 (trustmybot/tmb#89):

- **Channels live side by side.** Each channel installs under its own name, updates only itself, and keeps its own machine-wide state. A project is run by the program that initialised it.
- **An older tmb refuses a newer database.** It stops and says which version wrote it. That is the only refusal: a project can be moved to another channel, in either direction, whenever that channel's program can read the database.
- **tmb's own installer and updater come first.** Install through a package manager is built, but not supported and not tested before v1.x ([Package managers](#package-managers)).

## Channels and updates

| Channel | Holds |
|---|---|
| dev | Every merge to the base branch. |
| rc | Release candidates. |
| stable | Releases. |

Release files are published to one public repo, separate from the source repo, so install and updates are plain downloads that need no login. The source repo is public too, and its README offers the stable channel only, with a link to the release repo for rc and dev. On the release repo, stable is a normal release, rc is a prerelease, and dev is one rolling prerelease.

An install follows one channel. Updates are pushed to each channel; tmb checks for one when it starts and installs it at once. A session that is running keeps the build it started with, so a task never meets a new build half way. With no network it runs the version it has.

As built at level 8, as agreed on trustmybot/tmb#16 (pending the Human's review):

- A build's version names its channel: `X.Y.Z-dev.N` is dev, `X.Y.Z-rc.N` is rc, `X.Y.Z` is stable. Every release carries a `VERSION` file and the checksums of its files.
- dev is the rolling `dev` prerelease, published on every push to the base branch. rc and stable are published only when a `vX.Y.Z-rc.N` or `vX.Y.Z` tag is pushed: rc as a prerelease, stable as the release marked latest. rc's newest release is found through the public releases API.
- When a session starts, tmb looks for a newer build on its channel at most once an hour, downloads it in the background, verifies it and keeps it. `tmb update` does the same on request.
- **An update installs at once, whatever is running** (trustmybot/tmb#159, decided by the Human on 2026-11-20). It installs at a session's end or on `tmb update`.
- **A running session keeps its build, and so does its project.** While the session runs, every tmb call in that project runs the build the session started with: the host's events, the tool server, git's push hook and a command the Human types. So the record keeps its shape and the host files stay as they are until the session moves.
- **The session moves by itself.** tmb's tool server moves to the new build at the session's next tool call, once no task is open in the project, and says so in one line. The conversation is kept and the Human does nothing. When the move fails, the session keeps its build and tmb says how to reconnect the tool server in that host.
- **`tmb update` names each session still on an old build**, with its folder, title and start time, and why it waits.
- **An old build is never deleted by itself.** tmb says how many old builds no session uses and their size. `tmb doctor` lists them and deletes them on the Human's yes (trustmybot/tmb#160).
- Not checked: whether each host reads tmb's tool list again after a move.

Channels and versions live side by side, as built for trustmybot/tmb#89 (Part 2):

- Each channel is a program of its own name: `tmb` follows stable, `tmb-rc` rc, `tmb-dev` dev, and `tmb-<version>` is one rc or stable release that never updates itself. The name is the installed file's. A `tmb` follows the channel its version names, so a dev build installed as `tmb` before the names were split keeps following dev.
- Each program updates itself only from its own channel and keeps its machine-wide state in a folder of its own name, so one never swaps another.
- A project is tied to the program whose init last wired it: its hooks, its tool server and git's push hook call that program, and the record's audit trail keeps every move from one program to another.
- The record's shape is signed with the version and program that wrote it. A tmb that finds a newer shape than it knows refuses the record and names them.
- The installers take `TMB_CHANNEL` and, to pin one release, `TMB_INSTALL_VERSION`, and install under the matching name.

## Package managers

Built. Not supported and not tested before v1.x (trustmybot/tmb#91): the Human decided on 2026-11-19 that tmb's own installer and updater come first. In v1 the installer scripts are the only supported way to install, and no v1 release waits for, or runs, a test of a package-manager install.

The installer scripts stay. Package managers are added beside them.

| Where | Route | Channels |
|---|---|---|
| macOS and Linux | tmb's own Homebrew tap, as a cask. On macOS it waits for notarization. | `tmb`, `tmb@rc` and `tmb@dev`, installing `tmb`, `tmb-rc` and `tmb-dev` |
| Windows | tmb's own Scoop bucket, then winget's community list | Scoop: `tmb`, `tmb-rc` and `tmb-dev`. winget: one package per channel. |
| Linux without Homebrew | The installer script | |

- **Who updates.** tmb keeps its own updater on every route. The cask says so with `auto_updates`, and the winget package refuses winget's own upgrade, so the package manager leaves upgrades to tmb.
- **How a manifest is filled.** Every manifest is a template in the source repo. When a release is published, the release workflow fills in its version and the checksums from its `SHA256SUMS`, and pushes the cask to the tap and the Scoop manifest to the bucket. A release that is no longer the newest on its channel leaves them as they are. The winget manifests are kept with the workflow run, for a submission to winget's list.
- **macOS needs a signed and notarized program first.** Homebrew marks what it downloads as quarantined, for casks and formulae alike, and macOS refuses to run a quarantined program that is only signed ad hoc. So a Homebrew install of tmb on macOS installs, then does not run. The release workflow must sign the macOS files with a Developer ID and have Apple notarize them before Homebrew can serve macOS. The Human decided on 2026-11-20 to wait with that: until then the installer script is the only route on macOS, and the tap says so. The installer script works because curl does not quarantine. Tested on macOS 15 with Homebrew 7.0.15 (trustmybot/tmb#91).
- **A cask, not a formula.** A formula would not avoid the quarantine, and Homebrew does not allow a formula name with `@` before a letter, such as `tmb@dev`.
- **Until the tap and the bucket exist.** The step skips, and the release still succeeds. Planned for v1.x (trustmybot/tmb#91): the Human creates the tap, the bucket and their token, and submits to winget.

A plugin project's records are carried over by `tmb migrate`, a one-way copy from the plugin's database that leaves it unchanged (trustmybot/tmb#17, [reference](../reference/README.md#move-a-plugin-project)). A plugin project of several repos goes into one workspace record: each plugin repo goes to the workspace repo of the same name, or to one the Human names, and tmb never guesses a repo (trustmybot/tmb#193).

## Feedback

Built for v1.0.0 (trustmybot/tmb#122). Decided by the Human on 2026-11-20. How to use it is in the [reference](../reference/README.md#report-a-bug-in-tmb).

- **The planner drafts a bug report when tmb itself breaks, and the Human says yes to each one.** Nothing is sent by itself, on any channel. `tmb feedback` drafts one on request.
- **On by default on dev and rc, asked about on stable**, once, at the first run. The setting belongs to the person: it is kept with the machine-wide state of each channel's program.
- **A report is an issue on the source repo, from the user's own GitHub account.** With GitHub's CLI signed in, tmb files it. Otherwise tmb opens the repo's bug form filled in, and the user submits it. A link is kept under 7,500 characters; a longer report is saved to a file to attach.
- **A report follows the repo's bug form.** tmb reads the form as it stands on the default branch and sends only the fields that form has, so the version, the labels and the questions are always the current ones ([contributing](../contributing/README.md#issues)). With no network it uses a built-in copy, which the build takes from the repo's own form file, so the two cannot differ.
- **Labels come from the form on both routes.** GitHub drops the labels of an issue filed through its API by someone who cannot write to the repo. So a report filed through the CLI carries one hidden line, `<!-- tmb-feedback form=bug.yml -->`, and a workflow on the repo reads that form's labels and adds them. Not yet seen running on a real report.
- **A report holds no source code, file contents, prompts, agent messages or environment variables.** Paths and values that look like secrets are cleaned before the Human sees it.
- **The record keeps each report filed, with its link, and each form opened.** For an opened form it cannot know whether the user pressed submit.

## Offline

The engine, the record, the code graph and the dashboard need no network. Whether the agents themselves run offline depends on the host and its models.
