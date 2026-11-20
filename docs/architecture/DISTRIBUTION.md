# Distribution

How tmb is packaged, installed and updated.

## Package

One compiled file per platform: macOS, Windows and Linux. It contains the engine, the command line, the tool server, the dashboard's pages and every host adapter. Nothing else has to be installed first.

The packaging test runs at level 0 of the build: one compiled file that runs on all three platforms with no network, opens the database, parses code and answers a tool call from a host. If it fails, the language decision is reopened.

## Install

One step per platform. After it, two commands inside a project:

| Command | Does | Asks questions |
|---|---|---|
| `tmb init` | Finds the installed host and has its adapter register tmb's tools, roles and guards with it ([HOSTS.md](HOSTS.md)), creates the project's database, adds git's push hook and indexes the code graph. It leaves tmb's settings empty and ends by saying so and how they get filled. | No |
| `tmb onboard` | Sets the project's settings: the base branch, the review mode, the checks to run, a host's role. It can be run again at any time. | Yes |

**Onboarding happens by itself.** When a session starts in a project whose settings are empty, the engine tells the planner. The planner works out the settings it recommends for that project, applies them through its `settings_set` tool and shows them. It reminds the Human that `tmb onboard` can be run again at any time, and that the planner can change a value when asked. In an unattended run it does the same and names each value it applied.

Init and onboard replace the earlier `tmb setup`, which is gone (trustmybot/tmb#89). Files an earlier build marked as written by `tmb setup` are still recognised as tmb's, so init replaces them and remove deletes them.

Removing tmb from a project (`tmb remove`) undoes exactly what init added and leaves the Human's own settings alone.

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

Release files are published to one public repo, separate from the source repo, so install and updates are plain downloads that need no login. The source repo stays private for now. On that repo, stable is a normal release, rc is a prerelease, and dev is one rolling prerelease.

A compiled file is not secret: its bundled code can be read. The public repo hides the source repo's docs, issues and history, not the code.

An install follows one channel. Updates are pushed to each channel; tmb checks for one when it starts and applies it between sessions, never in the middle of a task. With no network it runs the version it has.

As built at level 8, as agreed on trustmybot/tmb#16 (pending the Human's review):

- A build's version names its channel: `X.Y.Z-dev.N` is dev, `X.Y.Z-rc.N` is rc, `X.Y.Z` is stable. Every release carries a `VERSION` file and the checksums of its files.
- dev is the rolling `dev` prerelease, published on every push to the base branch. rc and stable are published only when a `vX.Y.Z-rc.N` or `vX.Y.Z` tag is pushed: rc as a prerelease, stable as the release marked latest. rc's newest release is found through the public releases API.
- When a session starts, tmb looks for a newer build on its channel at most once an hour, downloads it in the background, verifies it and keeps it. It swaps it in at a session's end, only when no other tmb session is running and no task is open in any project tmb has served. A task is one agent's run and is short, so an open task holds the swap back only briefly, and a half-done task never meets a new build. `tmb update` does the same on request.

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
| macOS and Linux | tmb's own Homebrew tap, as a cask | `tmb`, `tmb@rc` and `tmb@dev`, installing `tmb`, `tmb-rc` and `tmb-dev` |
| Windows | tmb's own Scoop bucket, then winget's community list | Scoop: `tmb`, `tmb-rc` and `tmb-dev`. winget: one package per channel. |
| Linux without Homebrew | The installer script | |

- **Who updates.** tmb keeps its own updater on every route. The cask says so with `auto_updates`, and the winget package refuses winget's own upgrade, so the package manager leaves upgrades to tmb.
- **How a manifest is filled.** Every manifest is a template in the source repo. When a release is published, the release workflow fills in its version and the checksums from its `SHA256SUMS`, and pushes the cask to the tap and the Scoop manifest to the bucket. A release that is no longer the newest on its channel leaves them as they are. The winget manifests are kept with the workflow run, for a submission to winget's list.
- **Until the tap and the bucket exist.** The step skips, and the release still succeeds. Planned for v1.x (trustmybot/tmb#91): the Human creates the tap, the bucket and their token, and submits to winget.

A plugin project's records are carried over by `tmb migrate`, a one-way copy from the plugin's database that leaves it unchanged (trustmybot/tmb#17, [reference](../reference/README.md#move-a-plugin-project)).

## Offline

The engine, the record, the code graph and the dashboard need no network. Whether the agents themselves run offline depends on the host and its models.
