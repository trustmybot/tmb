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

## Offline

The engine, the record, the code graph and the dashboard need no network. Whether the agents themselves run offline depends on the host and its models.
