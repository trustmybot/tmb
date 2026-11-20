# Code graph

A graph of the project's code: its directories, files and symbols, and the links between them. Agents ask it where something lives and what depends on it, instead of reading whole files.

The plugin called this the world model.

## What it holds

- **Directories and files.** Each with a short summary taken from its README or its header.
- **Symbols.** Each file's definitions and the links between them: calls, imports, database reads and writes, and which tests cover what.
- **Concepts.** Flows and rules written by agents, each anchored to the symbols that carry it out. They link a design page to its code.

## What it answers

| Question | Asked by |
|---|---|
| What does this project look like? | The planner at the start of a session |
| Where does X live? | Every role |
| What calls or imports X, and which tests cover it? | The planner when it scopes a task; the worker before it changes X; the reviewer when it judges what a change may break |

## Rules

- **Built from git, never from the working folder.** Each repo is indexed at the commit of its base branch, so every session and worktree reads the same graph. A task's own commit is laid on top, so a worker sees its change and its base together.
- **It never guesses.** A reference is linked to a definition only on proof, such as a resolved import. What could not be resolved is reported as unresolved.
- **It can always be rebuilt.** Everything except concepts is derived from git. A rebuild keeps the concepts and re-checks each against the new graph; one whose code is gone is marked broken, never dropped.
- **It keeps itself fresh.** A read brings a graph that is behind its base branch forward before it answers. A full rebuild is the fallback.
- **Summaries are untrusted text.** They come from file contents, so they are shown to agents as data, never as instructions.
- **It works offline.** Indexing needs no network. Search by meaning uses a small local model; when that model is absent, search by name still works.

## Indexing

```mermaid
flowchart TD
    A[tmb init, a new base branch from onboard, tmb index, or a merged change of structure] --> B[Read and parse each repo at its base commit]
    B --> C[Apply the whole graph in one step]
    C --> D[Re-check concepts]
    E[A read or a task start] --> F{Graph behind the base branch?}
    F -- yes --> G[Bring it forward; on failure, rebuild that repo]
    F -- no --> H[Answer from the current graph]
    G --> H
```

## Every function, and a page to see it

Planned for v1.0.0. Decided by the Human on 2026-11-20: the code graph shows code as a graph, at function level, and no function is left out. The details below are proposed, for the Human's review, in each issue.

Today the graph holds every named function at the top of a file and every class method, but few of the functions without a name. Measured on tmb's own repo on 2026-11-20, against the TypeScript compiler: 1,250 of 3,256 functions, 38%.

- **Every function is a node, unnamed ones included** (trustmybot/tmb#140). TypeScript and JavaScript first. Each symbol gets a link to what contains it: a function, a class or the file. An unnamed function is named by where it is used.
- **A coverage test holds it at 100%.** A second, independent parser lists every function, and the graph must match it one to one.
- **Nothing is skipped in silence.** A file that could not be parsed is in the graph as a file marked so, and is counted.
- **Agents' answers do not change.** A lookup names the nearest named function, and unnamed functions stay out of search.
- **The dashboard gets a code graph page** (trustmybot/tmb#142): folders, then files, then functions, one level at a time, and a view of one function with its callers and what it calls. It never draws every function at once.
- **Areas** (trustmybot/tmb#146): the planner groups files into the project's logical parts, such as login or billing, and "tests" is an area from the start. Every file and function names its area, and the page draws each area as a box around its files.
- **Imports through a path alias or a package name resolve to their files** (trustmybot/tmb#147), so the links are there to draw.
- **Python, bash and the other languages follow**, each with its own coverage test (trustmybot/tmb#141, v1.x).

## Honest limits

Agents do not always use a graph when one is offered, and a symbol lookup can cost more than a plain text search for a simple question. So the graph is used where it earns its cost: scoping a task, and finding what a change may break. Plain search stays available for everything else, and every miss or wrong answer of the graph is recorded so its value can be measured.
