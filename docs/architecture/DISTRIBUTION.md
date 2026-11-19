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

## Package managers

The installer scripts stay. Package managers are added beside them (trustmybot/tmb#89, Part 3).

| Where | Route | Channels |
|---|---|---|
| macOS and Linux | tmb's own Homebrew tap, as a cask | `tmb`, `tmb@rc` and `tmb@dev`, installing `tmb`, `tmb-rc` and `tmb-dev` |
| Windows | tmb's own Scoop bucket, then winget's community list | Scoop: `tmb`, `tmb-rc` and `tmb-dev`. winget: one package per channel. |
| Linux without Homebrew | The installer script | |

- **Who updates.** tmb keeps its own updater on every route. The cask says so with `auto_updates`, and the winget package refuses winget's own upgrade, so the package manager leaves upgrades to tmb.
- **How a manifest is filled.** Every manifest is a template in the source repo. When a release is published, the release workflow fills in its version and the checksums from its `SHA256SUMS`, and pushes the cask to the tap and the Scoop manifest to the bucket. A release that is no longer the newest on its channel leaves them as they are. The winget manifests are kept with the workflow run, for a submission to winget's list.
- **Until the tap and the bucket exist.** The step skips, and the release still succeeds. Planned: the Human creates the tap, the bucket and their token, and submits to winget.

A plugin project's records are carried over by `tmb migrate`, a one-way copy from the plugin's database that leaves it unchanged (trustmybot/tmb#17, [reference](../reference/README.md#move-a-plugin-project)).

## Offline

The engine, the record, the code graph and the dashboard need no network. Whether the agents themselves run offline depends on the host and its models.
