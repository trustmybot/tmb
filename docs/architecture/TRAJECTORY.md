# Trajectory

The record of the work: what was asked, what was decided, what each agent did and how it ended. Any session can resume from it without the conversation that came before.

## What is recorded

| Record | Holds |
|---|---|
| Issue | A goal, its state and its milestone. |
| Discussion | Notes and decisions on an issue. The newest decision is the one in force. |
| Task | A spec, its state, its branch and its commit. |
| Run | One agent working on one task or one review, from start to end, with how it ended and its cost ([Runs](#runs)). |
| Check run | The checks run on a commit and their result. |
| Review | A reviewer's verdict on a commit or a feature branch, with its findings. |
| Guard decision | Every allow and deny the gate gave, and why. |
| Audit entry | Every change to configuration and every Human waiver. |

## Rules

- **Nothing is skipped silently.** A step that did not run is recorded as not run, with the reason.
- **A start without an end is a finding.** Every run and check records its start and its end. What is stuck is whatever has a start and no end.
- **The engine is the only writer.** Agents, the command line and the dashboard change the record only through the engine, so every rule is enforced in one place.
- **Reads return small pieces.** A brief, a section or a ranked snippet, never a dump. Agents spend their context on the work.
- **History is kept, not overwritten.** A change of state is added as an event; the current state is derived from the events.
- **Every record names who made it.** The Human, or the role and host that acted. Planned: it also names the host session, so the work of two sessions on one project can be told apart, and a session with a start and no end is a finding (trustmybot/tmb#63). tmb still starts no session and assigns no work between them.
- **Ids never collide across machines.** A record made on one machine can be copied to another without renumbering.

## Runs

Decided by bro, for the Human's review (trustmybot/tmb#133, trustmybot/tmb#135).

- **A run ends as finished or stopped.** A worker's run is finished when its task left the open state during the run. A reviewer's run is finished when it recorded a review. Every other end is stopped, a reviewer that gave no verdict included.
- **Cost is tokens, per model:** input, output, cache read and cache write. The host's adapter gives them. For Claude Code they come from the subagent's transcript, each message counted once. A run whose transcript cannot be read has no cost, and that is not an error.
- **tmb records no price.** Prices change and a subscription has none per run.
- **A run names its task or its feature branch.** A review of a whole feature branch has no task, so its run is linked to the branch it reviewed. A review names the run that wrote it.

## Where it lives

One database file per project, inside the project's folder and left out of git. A workspace of several repos shares one. The engine creates it at `tmb init`, and is the only program that migrates it.

| State | Gate | Other commands |
|---|---|---|
| No database | Allows: tmb stays out of projects it was never set up in | Offer `tmb init` |
| Readable | Decides normally | Run normally |
| Unreadable, or made by a newer tmb | Denies, naming the cause, and for a newer one the version and program that wrote its shape | Only the health check and repair run |

## The code graph is separate

The [code graph](CODE_GRAPH.md) is not part of the trajectory. It can be rebuilt from git at any time, and it lives in its own file. Indexing is not recorded in the trajectory either: the graph file keeps, for each repo, the commit it was built at, when and what it holds.

## Plugin projects

A one-way migration tool carries a plugin project's records into a new tmb database. The plugin's database is left untouched. It carries over only what tmb supports: a kind of record tmb does not have is left behind, not folded into another kind.
