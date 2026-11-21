# Deterministic layer

The rules for moving tmb doctrine out of prompts and into code: the layers, what each guarantees, which layer covers which interaction, and how to add a deterministic check. How to write the prompts that stay in layer 6 is in [`JUDGMENT_LAYER.md`](JUDGMENT_LAYER.md).

> **If a step could fail because the LLM forgot, misordered, or misunderstood it, that step does not belong in a prompt. It belongs in a deterministic layer.**

## The 6 layers (hardest → softest)

| # | Layer | What it is for | What it guarantees |
|---|---|---|---|
| 1 | **Engine** (behind the tool server and the command line) | Role-bound tool access, input validation, server-side defaults for omitted args, and atomic composite tools that run a multi-step workflow as one call. | Wire-level rejection (`is_error: true`) regardless of prompt content; a composite's steps land together or not at all. |
| 2 | **Checkpoints** | git's own hooks first (pre-push refuses a push), then the few host hooks an adapter writes: PreToolUse blocks an agent start until its prerequisite holds; SubagentStop records the run's end; SessionStart injects context. No hook guards each edit. | A block or side effect runs outside the LLM's context, whatever the prompt says. A fail-closed gate also denies when it errors or runs out of time; a fail-open gate lets the call through then. Injected context is advisory: it reaches the model but compliance stays at layer 6. |
| 3 | **Role file** | The tool list in each role file, written by the host's adapter from what the role may do. | The host withholds the listed tools at spawn. Claude Code does; Codex has no per-agent switch for file edits. |
| 4 | **Schema constraints** | `CHECK`, `UNIQUE`, `NOT NULL`, FK on the trajectory DB. | Rejects malformed writes at the storage layer, including raw-SQL bypasses of MCP handlers. |
| 5 | **Skill `paths:`** | Skill auto-loads when matching files are in the active context. | Soft — reduces prompt noise; the model can still ignore loaded content. Planned: tmb ships no skill yet. |
| 6 | **Prompts** | The role prompts in `roles/`, skill prose (Planned): the judgment layer. | None — accept the compliance ceiling. |

**Doctrine: prefer the hardest layer that fits.** Layer 6 is the fallback, not the default. Move a constraint to a harder layer as soon as the softer layer it sits in fails to enforce it.

The layers stack: a rule a prompt states should also be caught by a harder layer, so a dropped prompt line fails loudly (a block, a rejection) instead of silently. Layers 1 and 4 and git's pre-push hook hold in every host configuration; the rest of layer 2 depends on the host firing tmb's hooks.

Source of truth for each layer's implementation: the gate's rules in `src/engine/decide.ts` and `src/engine/push-gate.ts` (each host's hooks are wired under `src/adapters/`), tools under `src/engine/handlers/`, role files from `roles/` and `src/engine/roles.ts`, constraints in `src/engine/store/schema.ts`, tmb's settings in [`CONFIG_KEYS.md`](../architecture/CONFIG_KEYS.md).

## What stays in layer 6

Recognizable by the verb. **Anything that is *classifying*, *composing*, or *weighing novel context*.**

| Verb class | tmb examples |
|---|---|
| **Classify / decide** | "Is this an architectural change?" "Is this scope creep?" |
| **Draft / compose** | Spec body, commit messages, issue descriptions, Q+A wording, discussion notes |
| **Weigh / trade off** | "Should I raise this concern with the human?" "Is the simpler alternative acceptable?" "Should the scope split into multiple tasks?" |
| **Synthesize from novel context** | Code review qualitative assessment, consultant-style analysis (consultants: Planned) |
| **Recognize patterns in unfamiliar input** | "Does this diff match the spec?" "Is this a regression in the diff?" |

Code cannot replace these: each needs judgment in context, and the possible inputs are open-ended.

## What migrates out of layer 6

Recognizable by mechanism. **Anything that is *sequencing*, *defaulting*, *constraining*, or *measuring* against a stable specification.**

| Pattern in prompt prose | Migrates to |
|---|---|
| "Then call X with Y" (multi-step) | Layer 1 atomic composite |
| "If config has X, use it; otherwise default Y" | Layer 1 server-side default |
| "Tool X is forbidden for role Y" | Layer 1 role check |
| "Validate input matches schema" | Layer 1 input validation, or a layer 4 constraint |
| "Probe the environment for X, Y, Z" | Layer 1 tool that runs deterministic code |
| "Don't proceed until Z has happened" | Layer 2 PreToolUse block |
| "After A, also do B" | Layer 1 composite; a layer 2 PostToolUse side effect is Planned |
| "Use this file naming / commit format" | A check at task close; tmb has no lint hook on each edit |

## The boundary test (apply this to any prompt line)

For every numbered step or imperative in a skill or a role file:

1. **Strike the verb.** Is what remains a *fact about the world* (file exists, role has access, value is X)? → migrate. Is it a *judgment* (is this good, what should I write)? → keep.
2. **Imagine the LLM dropping this line.** Does the workflow break in a deterministic way (test fails, hook blocks, server rejects)? If not, only the prose guards against the mistake: build a check that catches it.
3. **Count the steps.** Failures compound in a multi-step workflow: if the model follows each step with probability p, an N-step procedure succeeds with probability pᴺ.

| N (steps) | P(success) at p=0.95 | P(success) at p=0.90 |
|---:|---:|---:|
| 1 | 95% | 90% |
| 3 | 86% | 73% |
| 5 | 77% | 59% |
| 7 | 70% | 48% |

A composite turns N steps into one: the model decides once to make the call, and code runs the steps.

## Coverage matrix

The "Layer" column names the **strongest currently deployed** layer for each interaction. `6 only` means prompt-only — relies on LLM compliance. tmb gates the outcome, so a rule the plugin guarded at each step is checked at a checkpoint instead, and the row names it: close, review or push. Which file implements a row lives in the sources named above.

### Planner (bro)

| Interaction | Layer |
|---|---|
| Session start: the planner's role, the open work and the empty settings injected | 2 (injection) |
| A docs task changes only docs file types; any other file refuses its close | 1 (close) |
| Every code change goes to a worker | 6 only |
| The planner's docs task commits pass the same checks and push gate as code; the reviewer sees them in the same review | 1 (close) + 2 (push) |
| The main folder never switches onto a branch an open task owns | 6 only; the close reports what changed in the main folder |
| A cheatcode installs only after the Human approves that candidate | Planned (trustmybot/tmb#112) |
| The planner's open work restored from the record at each session start | 2 (injection) |
| Project `.gitignore` excludes tmb's project folder | 1 (init) |
| tmb cuts every task branch and worktree; a worker starts only on a task whose worktree is ready | 1 + 2 |
| Feature branch cut from the fetched base branch; a truest task rebased onto a moved base before its pull request | 1 |
| Base branch brought into a feature branch before its review | 6 only; the brief says whether the branch holds the base |
| Worktree cleanup on task close | 1 (close) |
| No task starts until the review mode is set | 1 |
| The code graph read before a task starts | 6 only |
| A decision recorded for every task | 6 only |
| Project skill and agent files change only with the Human's approval | Planned (skills and agent creation) |
| A tool call's `role` is one of the three roles, and defaults to the role the host was set up in | 1 |
| Feature branch, task start and drop, pull request, settings and areas are the planner's tools alone | 1 |
| A pull request opens only when a pass or a Human waiver covers the tip | 1 + 2 (push) |
| Issue sync | Planned (trustmybot/tmb#70) |
| Verify-context before answering, voice | 6 only |

### Worker

| Interaction | Layer |
|---|---|
| Started only when its prompt names an open task whose worktree is ready | 2 |
| A role's model and effort written into its role file; no effort per task | 3 |
| Rework after a failed review | 1 in truest mode (a fail reopens the task); 6 only in agile mode. Escalation after repeated fails: Planned |
| Runs in the task's own worktree, which tmb cut or adopted from the host | 1 + 2 |
| Its start and stop recorded as a run | 2 |
| Cannot create branches | 6 only |
| Its commit builds on the task's base commit | 1 (close) |
| Reads its brief before any other call | 6 only |
| Writes only under its task's worktree | 3 (Claude Code); the close reports what changed in the main folder |
| Lint and other project checks | 1 (close), not on each edit |
| Planner-only tools refused | 1 |
| Tool calls name the caller's role | 1 (a name outside the three roles is refused); passing its own role is 6 only |
| Never records its own verdict | 1 |
| Close runs the project's and the task's checks on the committed work; refuses on any failure | 1 (close) |
| Edits stay inside the spec's files | 1 (close, reported and not refused) + review |

### Reviewer

| Interaction | Layer |
|---|---|
| Its start recorded as a run, which a verdict needs | 2 + 1 |
| A task reaches a review only after its checks passed at close | 1 (close) |
| Push blocked unless a pass or a Human waiver covers the pushed commits | 2 (push) |
| The reviewer role is the caller's word, checked against an open reviewer run on that host | 1 |
| Recording a verdict is reviewer-only | 1 |
| A verdict is taken only on the branch's current tip | 1 |
| A fail reopens a truest task; in agile mode the planner starts fix tasks | 1 (truest); 6 only (agile) |
| Cannot edit code (read-only review) | 3 (Claude Code) + 2 (a write the host names as the reviewer's is denied) |
| Diff-level judgment: whether a behaviour change the probes show is a bug | 6 only |

### Consultants

Planned: a consultant is one kind of created agent, recorded and harnessed like the worker and the reviewer ([`EXTENDING.md`](../architecture/EXTENDING.md)). No rows until it is built.

### Universal

| Interaction | Layer |
|---|---|
| A push that brings onto the base branch a commit no review or waiver covers is refused, typed by hand too | 2 (push) |
| Only the Human waives a review | 1 |
| A step only the Human may take runs only on a terminal, after a typed yes | 1 |
| The gate denies when it cannot read the record | 2 |
| Naming conventions, commit subjects, mechanical code-quality patterns | 1 (close) where the project's checks cover them; else 6 only |
| Specs live in the record: a task starts only through the tool that records its spec | 1 |
| The planner's role injected in every session | 2 |
| Project map at session start | 2 |
| PR comment triage | Planned |
| Task close as one composite: checks, fold, backup push | 1 |

## How to add a deterministic check

1. Identify the failure mode. What's the bad thing if the LLM doesn't comply?
2. Pick the hardest layer that fits ([The 6 layers](#the-6-layers-hardest--softest)).
3. Implement it in that layer's source (see above) with a test; a layer 4 change to an existing table also needs its migration.
4. If the guard covers version-control commands, put it in git's own hook, which holds whatever was typed. tmb reads no shell command.
5. Rules compare tmb's own role names: each adapter turns its host's agent name into one first, and a rule that silently skips a role it cannot name is a disabled safety gate.
6. Update the coverage matrix. A layer 6 row notes that it may need promotion.
7. **Moving a rule to a softer layer needs its reason in the PR.**

## Prompt cache zones

Claude Code's prompt cache matches from the start of the assembled prompt and stops at the first byte that differs. tmb orders its context in three zones so the stable prefix stays as long as possible:

| Zone | Content | Stability |
|------|---------|-----------|
| **A — stable identity** | The planner's role (`roles/planner.md`), tool descriptions, fixed across all sessions and users | Stable |
| **B — semi-stable bodies** | Skill bodies (Planned), which change only on tmb updates | Semi-stable |
| **C — volatile hook tails** | Hook-injected context (counts, banners, branch, last commits), which changes every session or turn | Volatile |

**Contract for hook authors:** a hook that injects `additionalContext` puts its stable descriptive text first and its volatile fields at the tail of its own output, because a hook that opens with a volatile line breaks the cache for everything after it. Volatile fields include the branch name, commit and dirty-path counts, open-issue and pending-task counts, recent commit messages, the record's and tmb's paths, and any timestamp or PID.

In tmb the session-start hook is the only one that injects context: it puts the role first and the record's sections after it, and is held to this order by review.

## See also

- [`JUDGMENT_LAYER.md`](JUDGMENT_LAYER.md) — how to write and grade the layer 6 prompts.
- [`RESPONSIBILITIES.md`](../architecture/RESPONSIBILITIES.md) — agent roles and boundaries.
- [`FLOWS.md`](../architecture/FLOWS.md) — workflows: who acts, what each step guarantees, and the state each flow leaves.
- [`ERD.md`](../architecture/ERD.md) — schema.
- [`common.ts`](../../src/engine/handlers/common.ts) — defines the `requireRole` check behind layer 1; each tool's allowed roles are set at its `requireRole(...)` call in [`handlers/*.ts`](../../src/engine/handlers/).
