# Hosts and adapters

How tmb works with an agent program without being built for one. This is the top-level rule of the design: the engine knows nothing about any host, and everything a host needs is in its adapter.

## Terms

- **Host.** The agent program the Human talks to, such as Claude Code. The host's main agent is the planner.
- **Engine.** tmb itself: the record, the code graph, the workflow and the gate.
- **Host adapter.** The one part of tmb that knows a host: its file formats, its events and its limits.

## The rule

```mermaid
flowchart LR
    H[Human] --> P
    subgraph Host["Host, under the Human's own login"]
        P[Planner: the main agent]
        W[Workers: subagents]
        R[Reviewer: a subagent]
        P -- starts --> W
        P -- starts --> R
    end
    subgraph tmb
        A[Host adapter]
        E[Engine]
        A <--> E
    end
    P -- tools --> A
    W -- tools --> A
    R -- tools --> A
    Host -- "events: may this run?" --> A
    A -- allow or deny --> Host
    E --> G[git, checks, pull requests]
```

- The engine never names a host. A new host is a new adapter and no change to the engine.
- A host is never hardcoded outside its adapter: not in the record, not in the workflow, not in a prompt the engine owns.
- Roles are written once, in a host-neutral form. The adapter turns them into the host's own format.

## Many agents, started by the host

The host starts the workers and the reviewer as its own subagents. tmb does not start the host's models and never reads, stores or passes on a login.

| Step | Who |
|---|---|
| Decide that a task needs a worker | Planner |
| Prepare the worktree and the brief | Engine |
| Start the worker as a subagent | Host |
| Check that the start is allowed: the task exists, its worktree is ready, the role and effort match | Engine, asked by the adapter |
| Do the work, reading the brief and the code graph through tmb's tools | Worker |
| Run the checks, record the result, close or refuse | Engine |

Why this way:

- **It runs on the Human's subscription.** The work is ordinary use of the host by its own user. Anthropic's terms do not allow a third-party program to route requests through a user's subscription login, so a design where tmb starts Claude itself would need an API key.
- **It uses what the host already does well:** parallel subagents, a model and effort per role, isolation, and permission prompts shown to the Human.
- **It works wherever the host runs.** Claude Code fires the same events in its command line and in its desktop app.

Running several workers at once, each on its own task and worktree, is the host's parallel subagents plus the engine's rule that two open tasks never share a file.

## What an adapter provides

| Part | What it does |
|---|---|
| Detect | Finds the host, its version and what it supports. |
| Install | Registers tmb's tool server with the host, writes the role definitions in the host's format, and wires the host's events to the engine. Per project, with the Human's consent. |
| Translate events | Turns a host event (a tool call, a subagent start or stop, a session start) into the engine's neutral question, and the engine's allow or deny into the host's answer. It holds no rules of its own. |
| Report limits | Says what the host cannot do, such as deny a tool call or set a model per role, so the engine can fall back or refuse. |
| Remove | Undoes exactly what install added. |

All rules stay in the engine. An adapter that grows a rule is a defect.

## tmb's own events

tmb has its own hook system. Rules are written once against tmb's events, never against a host's or git's. Host hooks and git hooks are only sources that raise a tmb event.

```mermaid
flowchart LR
    HH[Host hook] --> A[Host adapter] --> EV[tmb event]
    GH[git hook] --> EV
    EN[The engine's own steps] --> EV
    EV --> RU[Rules in the engine]
    RU --> AN[Allow, or deny with the reason]
    RU --> RE[Every decision is recorded]
```

| tmb event | Raised when | Raised by |
|---|---|---|
| Session start | A host session opens in a tmb project | Host |
| Before a file write | An agent is about to write a file | Host |
| Before a command | An agent is about to run a shell command | Host |
| Before an agent start | The host is about to start a subagent | Host |
| After an agent stop | A subagent has ended | Host |
| Before a task start | The engine is asked to start a task | Engine |
| Before a task close | The engine is asked to close a task | Engine |
| Before a push | Commits are about to leave the machine | git, and the host for a push an agent types |
| After a branch moves | A merge, a fetch or a checkout moved a branch | git |

The event list is proposed, for the Human's review.

- An event carries the same fields whatever raised it: the role, the host, the task and what is about to happen.
- A rule answers allow or deny, and a deny always says why and what would be allowed.
- Version 1 ships tmb's own rules only. Users cannot add rules of their own on these events.
- A host that cannot raise an event is reported by its adapter, and the rules on that event fall back to the next event that can catch the same thing, such as the close or the push.

## Hosts

| Host | Status | Tools | Roles | Events that can deny |
|---|---|---|---|---|
| Claude Code, command line and desktop app | First | Tool server from the project's settings | Agent files in the project | Yes, from the project's settings, inside subagents too |
| Codex | Planned | Tool server from its config | Agent files in the project | Yes, after the Human trusts them |
| Others | Planned | | | |

The same three building blocks exist in both hosts checked so far, which is what makes one adapter shape enough.

When a host cannot deny an action, the engine's own layers still hold: checks at close, and git's pre-push hook ([WORKFLOW.md](WORKFLOW.md#the-gate)).

## What tmb leaves to the host

tmb starts no agent, runs no model and manages no parallel sessions. Hosts do that better, and tmb ships what they lack: one record, one code graph, one workflow and one gate.

## Different models on one task

- **One vendor, several models.** The host already runs a different model per subagent. The adapter writes each role's model into the host's role definitions.
- **Several vendors.** Planned, after the first host works end to end. Each host connects to the same record in the same project and takes a role: Claude Code plans and writes, and Codex, opened in the same project, reviews. Both read the same brief and pass the same checks and gate. The agents never talk to each other: the record is the handoff. Who starts the second host is the Human's or the first host's business, not tmb's.
- **Local models.** They arrive through a host that supports them.

Every record names the role and the host that made it, so a review is known to come from a different agent than the one that wrote the change.

## Ways into the engine

| Way in | Used by | Why |
|---|---|---|
| Tool server | Agents in a host | They read briefs and the code graph, and record their work. |
| Host events | The host, before an agent acts | The engine can refuse an action no agent asked it about. |
| Git's pre-push hook | git | A push is checked even when typed by hand. |
| Command line | The Human | Setup, indexing, health checks. |
| Dashboard | The Human | A local web page over the record. |

All of them call the same engine, so a rule cannot be skipped by choosing another way in.
