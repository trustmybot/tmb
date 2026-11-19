# Distribution

How tmb is packaged, installed and updated.

## Package

One compiled file per platform: macOS, Windows and Linux. It contains the engine, the command line, the tool server, the dashboard's pages and every host adapter. Nothing else has to be installed first.

The packaging test runs at level 0 of the build: one compiled file that runs on all three platforms with no network, opens the database, parses code and answers a tool call from a host. If it fails, the language decision is reopened.

## Install

One step per platform. After it, `tmb setup` inside a project:

1. Finds which hosts are installed and asks which to use.
2. Has the host adapter register tmb's tools, roles and guards with that host ([HOSTS.md](HOSTS.md)).
3. Creates the project's database and asks the few questions the workflow needs: the base branch, the review mode, the checks to run.
4. Indexes the code graph.

Removing tmb from a project undoes exactly what setup added and leaves the Human's own settings alone.

tmb is one program for the whole machine. Only the database and the host wiring are per project.

Planned (trustmybot/tmb#89), decided by the Human on 2026-11-19:

- **Setup splits in two.** `tmb init` prepares the project and asks nothing: the database, the host wiring, git's push hook and the code graph. `tmb onboard` sets tmb's settings, such as the base branch, the review mode and the checks. `tmb setup` is removed once both have shipped.
- **Onboarding happens by itself.** When a session starts in a project whose settings are empty, the planner works out the settings it recommends for that project, applies them and shows them. It reminds the Human that `tmb onboard` can be run again at any time, and that the planner can change a value when asked.
- **Channels live side by side.** Each channel installs under its own name, updates only itself, and keeps its own machine-wide state. A project is run by the program that initialised it.
- **An older tmb refuses a newer database.** It stops and says which version wrote it. That is the only refusal: a project can be moved to another channel, in either direction, whenever that channel's program can read the database.
- **tmb's own installer and updater come first.** Install through a package manager is later (trustmybot/tmb#91).

## Channels and updates

| Channel | Holds |
|---|---|
| dev | Every merge to the base branch. |
| rc | Release candidates. |
| stable | Releases. |

Planned: release files are published to one public repo, separate from the source repo, so install and updates are plain downloads that need no login. The source repo stays private for now. How the three channels map onto that repo is proposed, for the Human's review: stable as normal releases, rc as prereleases, dev as one rolling prerelease.

A compiled file is not secret: its bundled code can be read. The public repo hides the source repo's docs, issues and history, not the code.

An install follows one channel. Updates are pushed to each channel; tmb checks for one when it starts and applies it between sessions, never in the middle of a task. With no network it runs the version it has.

As built at level 8, as agreed on trustmybot/tmb#16 (pending the Human's review):

- A build's version names its channel: `X.Y.Z-dev.N` is dev, `X.Y.Z-rc.N` is rc, `X.Y.Z` is stable. Every release carries a `VERSION` file and the checksums of its files.
- dev is the rolling `dev` prerelease, published on every push to the base branch. rc and stable are published only when a `vX.Y.Z-rc.N` or `vX.Y.Z` tag is pushed: rc as a prerelease, stable as the release marked latest. rc's newest release is found through the public releases API.
- When a session starts, tmb looks for a newer build on its channel at most once an hour, downloads it in the background, verifies it and keeps it. It swaps it in at a session's end, only when no other tmb session is running and no task is open in any project tmb has served. A task is one agent's run and is short, so an open task holds the swap back only briefly, and a half-done task never meets a new build. `tmb update` does the same on request. Planned: the build on dev still swaps while a task is open.

A plugin project's records are carried over by `tmb migrate`, a one-way copy from the plugin's database that leaves it unchanged (trustmybot/tmb#17, [reference](../reference/README.md#move-a-plugin-project)).

## Offline

The engine, the record, the code graph and the dashboard need no network. Whether the agents themselves run offline depends on the host and its models.
