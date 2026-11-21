# Memory model

This is the key principle of tmb's memory system, for every agent on every host. Any change to what an agent loads, keeps or stores follows it. How many tokens tmb saves depends on how well memory swaps from hot to cold, and loads from cold to hot when needed.

tmb's memory works like a computer's:

| Tier | Computer | tmb | Holds | Cost |
|---|---|---|---|---|
| Cold | Hard disk | The record, and the code graph beside it | Everything permanent: issues, decisions, specs, verdicts, the project map | Paid once per load |
| Hot | RAM | Session context | Only what the current work reads often | Paid on every call while it stays |
| Pinned | Kernel | Role prompt, tool schemas, skill listing (skills are Planned) | What every call needs to function | Paid on every call by every agent, never evicted |

**The record is the only source of truth. Context is a disposable cache of it: everything is written to the record as it happens, so context is never the only copy. Every agent loads the smallest page it needs, and ends its session at a task boundary.**

One agent session moves memory between the tiers like this:

```mermaid
flowchart TD
    A["Session starts: the pinned tier loads the role prompt and tool schemas"] --> B[The work needs a fact]
    B --> C["Find it through an index: the code graph or ranked search"]
    C --> D{Read often in this session?}
    D -- yes --> E["Load the smallest page from the record into context, hot"]
    D -- no --> F["Read it once or in a subagent; only the conclusion enters context"]
    E --> G[Work and decide]
    F --> G
    G --> H[Write each decision to the record as it is made]
    H --> I{Dispatched work returned and closed or parked?}
    I -- no --> B
    I -- yes --> J["End the session: context is evicted and nothing is lost"]
    J -. the next session loads from cold .-> A
```

## Where the analogy breaks

These differences from real hardware are where the design decisions sit.

1. **Hot storage charges rent.** RAM costs nothing to hold, but context is re-read on every call, so an item costs its size times the calls left in the session. An item read once comes back as a conclusion and does not stay.
2. **No single item can be swapped out.** Context is append-only. Only two things remove items from context: ending the session, which loses nothing, and compaction, which loses detail and happens at a time tmb does not choose. A subagent works like a separate process with its own address space: only its return value enters the caller's context. So most savings come from not loading an item and from ending sessions on time.
3. **Write through, never write back.** Context is volatile, so a decision reaches the record when it is made. Evicting then loses nothing. A decision is anything a later step reads back, such as a status change, a verdict or a spec, and it is written before the work moves on. A change of state is added as an event, never written over, so the history stays.
4. **Evict at boundaries.** A session ends when its dispatched work has returned and been closed or parked. The one timer that matters is prompt cache expiry: the next call then pays full price for the whole context, so a cold restart is usually cheaper.

tmb does not trim the output of shell commands on its way into context: it watches no shell command. What keeps context small is the size of what tmb's own tools return.

## Loading from cold

- **Pages, not the disk.** A read returns the smallest useful unit: a brief, a section or a ranked snippet, never a dump.
- **An index first.** The code graph and ranked search snippets are the page table: they say where to read before anything is read.
- **The session start is one small page.** The planner starts with its role, the open work from the record, the project's directories from the code graph as last indexed, and one line when the health check has something to show.
- **The record must be trustworthy.** A stale record makes agents re-derive state or keep their own copies, which breaks the model. A memory file written to carry state between sessions signals a design flaw to fix.

## Search

Search is ranked word search plus the code graph. tmb ships no embedding model. Agent search comes first: a skill (Planned) teaches the planner to search with several word queries and follow the graph, and misses are measured on real questions. Embeddings come only if the misses are real.

```mermaid
flowchart TD
    A[An agent needs a fact] --> B{About the work or about the code?}
    B -- the work --> C["Ranked word search over issues, notes and decisions"]
    B -- the code --> D["Code graph: find by name, path or words"]
    C --> E{Found?}
    D --> F["Follow the graph: callers, importers, tests"]
    F --> E
    E -- no --> G["Ask again with other words"]
    G --> B
    E -- yes --> H[Read the smallest page it points to]
    D -. a miss or a wrong answer .-> M[Recorded as a graph miss]
```

- **Record search** returns ranked snippets from issue titles and bodies, notes and decisions. Every word of the query must match.
- **Code search** is by name, by path and by the words in a name or a summary, ranked. It asks for every word first and falls back to any word. See [WORLD_MODEL.md](WORLD_MODEL.md).
- **Agent search first.** A skill (Planned) teaches the planner to search with several word queries and to follow the graph from each hit.
- **Embeddings only on evidence.** Search by meaning is added only if measured misses show that word search and the graph do not find what is there. Graph misses are recorded for that measurement; misses of record search are not.

## Where the record lives

One database file per project, inside the project's folder and left out of git: `.tmb/trajectory.db`. `tmb init` creates it. A workspace of several repos shares one, in the workspace folder ([GIT.md](GIT.md)).

```mermaid
flowchart TD
    A[A tmb call starts in a folder] --> B{Does this folder hold a record?}
    B -- yes --> R[That folder is the project]
    B -- no --> C{Is there a parent folder?}
    C -- yes --> D[Step up one folder]
    D --> B
    C -- no --> N["No record: the starting folder is the project"]
```

- **The nearest record wins**, so a session that moved into a subfolder, or into one repo of a workspace, still finds its project. A `.tmb` folder with no database in it is passed over.
- **The code graph is not in the record.** It has its own file beside it, `.tmb/graph.db`, or in a workspace one per repo, `.tmb/graphs/<repo>.db` ([WORLD_MODEL.md](WORLD_MODEL.md#substrate)).
- **The engine is the only writer and the only migrator.** Agents, the command line and the dashboard change the record only through it. A record an older tmb wrote is upgraded by the next tmb command.
- **Other records are shown, not merged.** The health check lists records in a folder above the project or below it.

| Record state | Meaning | Gates | Other commands |
|---|---|---|---|
| No record | tmb was never set up here | Allow: tmb stays out of projects it never touched | Offer `tmb init` |
| Readable | The record answers a read | Decide normally | Run normally |
| Unreadable | Damaged or empty: a record file that is there but empty counts | Deny, naming the cause | None runs; each stops and names the cause. `tmb doctor` still runs |
| Made by a newer tmb | A newer program reshaped it: a downgrade, or two channels in one project | Deny, naming the version and the program that wrote it | None runs. Nothing downgrades a record; run the newer program there, or update this one |

A gate denies when the record is unreadable, so it never lets through what it cannot check. A gate allows when there is no record, so tmb stays out of projects it never touched.

### When the health check is not green

`tmb doctor` is the health check. It checks the machine and the project, prints one line per check with the step that fixes it, and exits 1 when a check failed. [The reference](../reference/README.md#check-this-machine-and-project) lists every check.

```mermaid
flowchart TD
    A["A checkpoint: file write, subagent start or push"] --> B{Record state?}
    B -- none --> C[Allow]
    B -- readable --> D[Decide normally]
    B -- "unreadable or newer" --> E["Deny and name the cause"]
    E --> F["tmb doctor: reads the record read-only"]
    F --> G{Which cause?}
    G -- damaged --> H["tmb doctor --fix repairs it on the Human's yes and keeps the damaged file"]
    G -- newer --> I["Run the program that wrote it, or update this one"]
    H --> D
    I --> D
```

- **What is denied.** File writes, subagent starts and pushes, and every tmb command and tool but the health check. Reading files and running shell commands stay possible, because tmb watches neither, so the agent can see what is wrong and tell the Human.
- **It only reads.** The health check never deletes without the Human's yes and never touches a file tmb did not write. With a terminal, its fix mode asks about each fix, one at a time.
- **It runs with a broken record.** Every check that does not need the record still runs; the ones that do say why they were skipped.
- **A start without an end is a finding.** It lists runs and checks with a start and no end, and open tasks no agent run is on ([TRAJECTORY.md](TRAJECTORY.md)).
- **The code graph is checked too:** behind its base branch, built by an older indexer, or holding files that could not be parsed. Each is a finding with `tmb index` as the fix.
- **The planner hears of it in one line** at session start, "N things need a look", from the quick checks only, so its context stays small.
- **A check that fails by itself looks like tmb's own bug.** Its line says so and names the bug report command.

## Every agent

| Agent | Keeps hot | Loads from cold when needed |
|---|---|---|
| planner | The Human's current ask and the work in flight | Issues, decisions, the project map; investigation goes to a subagent |
| worker | One task's spec and the files it edits | Its task brief, the code graph |
| reviewer | One task's or one feature branch's diff and its findings | Its brief, check runs, the code graph |
| consultant (Planned) | One question | Notes and decisions, the code graph |

## Design test

Ask these of any change that adds context, a tool result, a prompt line or a store:

1. Which tier does it live in, and is that the cheapest tier that works?
2. If it is hot or pinned, how many calls pay for it, and is it read often enough to earn that?
3. If it is hot, what evicts it, and is it already in the record by then?
4. If it is loaded from cold, is that the smallest page, and can it be found through an index?
