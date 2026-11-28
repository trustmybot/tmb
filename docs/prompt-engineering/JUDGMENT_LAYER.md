# Judgment layer

The rules for writing and grading a tmb prompt (`roles/*.md` and `skills/*.md`), the layer 6 that holds only what needs judgment: a checklist of yes/no criteria, a grading rubric, and real examples. Which rules belong in code instead is in [`DETERMINISTIC_LAYER.md`](DETERMINISTIC_LAYER.md). Each criterion names its rule in [`PROMPT_ENGINEERING.md`](PROMPT_ENGINEERING.md), the research reference, and carries that rule's evidence tier.

---

## Definition

A prompt is golden when it passes every criterion below, grades A on the rubric in [Grading a prompt](#grading-a-prompt), and has a representative eval set showing no regression after its last wording change.

Golden is earned, not a style. The eval set is required because rule 7 is the only T1-backed way to call one wording better than another; the other criteria only make a prompt a strong candidate.

---

## Criteria

The criteria follow the order in which you write or read a prompt, one category at a time:

| Category | Asks |
|---|---|
| Identity | Who is the agent, and what one job does it own? |
| Content | What belongs in the prompt, and how is it laid out? |
| Wording | How is each rule phrased? |
| Output | What does the agent produce, and what shows the shape? |
| Consistency | Does the whole file agree with itself, other prompts, hooks and code? |
| Validation | Did an eval show no regression? |

`Rule` is the rule number in [`PROMPT_ENGINEERING.md`](PROMPT_ENGINEERING.md#core-rules), or the section below that holds the tmb-specific rule. `Tier` copies that rule's tier. `How checked` is `deterministic` when a grep, lint or script could check it, `judgment` when a reader has to.

| Category | ID | Check | Rule | Tier | How checked |
|---|---|---|---|---|---|
| Identity | G1 | The role and objective are in the first lines. | 5 | T1 | judgment |
| Identity | G2 | The prompt does only its agent's job: it names what it receives, hands its output over in the shape the next agent expects, and redoes no check another agent owns. | [Each prompt owns one job](#each-prompt-owns-one-job) | none (convention) | judgment |
| Content | G3 | Situational or optional detail lives in a skill or command, not the always-loaded prompt. | 2 | T1 | judgment |
| Content | G4 | The rules are few and concrete, and the most important come first; "use good judgment" with no criteria is not a rule. | 1, 10 | T1 | judgment |
| Content | G5 | The prompt uses one structure style throughout, and a prompt that mixes instructions, context, examples, and inputs tags each part. | 3 | T1; T3 for tags | judgment |
| Content | G6 | Tool output, fetched pages, files, and comments sit in named tags marked as data, and what the agent may do with them is decided in a hook or gate. | 14 | T2 boundary; T3 tags | judgment |
| Wording | G7 | Each prohibition names what to do instead, and none names a word only to forbid it. | 9 | T2 (mixed) | judgment |
| Wording | G8 | Each non-obvious rule gives its reason. | 13 | T3 | judgment |
| Wording | G9 | No emphasis words (CRITICAL, MUST, ALL CAPS, ALWAYS, NEVER) appear outside true invariants. | 12 | T3 | deterministic |
| Wording | G10 | There is no expert persona, "think step by step", tip, threat, flattery, or urgency boilerplate. | 4, 5, 6 | T1 | deterministic |
| Output | G11 | Examples match the wanted output format, and there are 3 to 5 varied ones where a format needs them. | 8 | T2 | judgment |
| Output | G12 | The output shape is stated (a schema, a section layout, a table). | 10 | T2 | judgment |
| Consistency | G13 | No rule contradicts another rule, another prompt, or a hook; where two can collide, the precedence is stated. | 10 | T2 | judgment |
| Consistency | G14 | No rule is duplicated across sections. | 10 | T2 | judgment |
| Consistency | G15 | Tool and skill descriptions match the code they describe. | 11 | T2 | judgment |
| Validation | G16 | An eval set of representative cases exists and was re-run after the last wording change. | 7 | T1 | deterministic |

---

## Each prompt owns one job

Each prompt does only its agent's job. It names what the agent receives, hands its output over in the shape the next agent expects, and never asks the agent to redo a check another agent owns: overlapping jobs duplicate work and blur who owns a miss. This holds for every agent, a new one included. An agent in tmb's code flow also matches its place in [`FLOWS.md`](../flows/FLOWS.md) and its row of the [quality layers](../flows/3_TASKS.md#quality-layers) table; where the flow and its prompt disagree, fix one of them in the same change so they do not drift.

Each shipped prompt carries only the wiring that makes tmb work: who the agent is, what it does every turn, and pointers to the skills that hold procedures. Rubrics, checklists, persona and style guidance, and domain heuristics arrive as cheatcodes ([`4_EXTENDING.md`](../flows/4_EXTENDING.md#cheatcodes), Planned, trustmybot/tmb#112); a paragraph that teaches a technique instead of wiring a role belongs in one.

---

## Grading a prompt

### The six tests

| Test | Pass condition |
|---|---|
| **(A) Mechanism test** | Any line that sequences, sets a default, constrains, or measures moves to layers 1–5 ([`DETERMINISTIC_LAYER.md`](DETERMINISTIC_LAYER.md)). Only judgment stays. |
| **(B) If/else test** | Anything you can write as an if/else statement lives in checkpoints or the engine's tools, never in prompt prose. |
| **(C) Natural-language test** | If the Human cannot read a prompt line as natural language, it is machine-spec in disguise — migrate it or rewrite it. |
| **(D) Placement test** | Judgment needed on every run belongs in the always-loaded body, optional judgment in skills loaded on a trigger, and deterministic logic in code. |
| **(E) Persona test** | Every agent opens with a plain-language sentence naming its job, not an expert title ("You carry out one task's spec in the task's own worktree, then report back to the planner."). |
| **(F) Load-bearing test** | Every line drives a judgment, names a call, or states a constraint the reader acts on. No line sells the concept, narrates the skill's own purpose, restates the frontmatter, or repeats a point for emphasis. |

### Every line earns its place

A prompt loads into the agent's context every time its trigger fires, so every line is a recurring cost. Cut these four exposition patterns on sight:

- **Concept-selling** — persuading the agent a skill is worth using after it already loaded it.
- **Self-narration** — a skill describing what kind of skill it is.
- **Frontmatter restatement** — the body re-explaining the when/why already in the `description`.
- **Rhetorical repetition** — one point stretched across three sentences for emphasis.

### Line disposition

| What the line does | Action |
|---|---|
| Encodeable as if/else AND a gate already checks it | **DELETE** — the gate already guarantees the behavior. |
| Encodeable as if/else, no gate checks it yet | **KEEP** as readable prose, rewrite naturally, file a migration issue. |
| Required judgment (100% of runs) | **BODY** — move to the always-loaded agent file. |
| Optional/situational judgment | **SKILL** — trigger-loaded, not burned on every turn. |
| Explains, motivates, or restates rather than directing | **DELETE** — exposition, not judgment. |

A line is deletable only when its gate actually guarantees the behavior: grade the system, not the prose. If deleting a line would let an agent act before any gate catches it, strengthen the gate first, then delete the line. A gate's deny message tells the agent how to recover.

### A–F rubric

| Grade | What it means |
|---|---|
| **A** | Every line passes all six tests. |
| **B** | Compliant architecture, but carries residual machine-spec, exposition, or minor duplication. |
| **C** | Procedures written as a prompt: readable, but a check could decide them. Or so padded with explanation that the judgment is buried. |
| **D** | Prompt does the deterministic layer's job for at least one workflow step. |
| **F** | Agent can act against policy before any gate fires. |

### Size discipline

A skill over about 200 lines is a signal it is doing too much. Fix it in this order. First, apply the boundary test and move what it flags into code. Next, move judgment used on every run into the agent body and keep situational judgment in the skill. Split into several skills only when neither is enough. Measure density, not just length.

---

## Agent prompts

A prompt is a contract, not a wish: it states the role, the inputs, the steps, the output, and the boundaries. An agent also uses tools, acts on its own, and keeps state across turns, so its prompt covers the points below as well. They are vendor practice with no tier of their own.

- **Name the loop.** Make the cycle explicit: orient, verify context, act, verify the result, report.
- **Verify before finalizing.** Tell the agent to check its work against the spec or success criteria before it declares done, and to surface failures.
- **Ground claims and allow "unknown".** Give the agent a retrieval path and an explicit route to ask or say "unknown" instead of guessing.
- **Set autonomy boundaries.** Say what the agent may do unprompted and what needs confirmation (irreversible, outward-facing, or destructive actions). Tell it to surface disagreement, then yield to the human.
- **Use what the harness gives.** When identity, state, or context arrive each turn, tell the agent to use them instead of fetching them again.

---

## Golden excerpts

Copied verbatim from current prompt files. Each excerpt is long enough to be read alone: every pronoun in it has its referent in the excerpt.

**`roles/planner.md`, "You are bro, the planner"** (G1, G7)

```text
You're **bro**, tmb's planner and the Human's single point of contact. tmb is the harness around this session: you plan the work, route it, and gate every step of it. You don't write production code yourself. Workers write it on a feature branch that is pushed as a backup as tasks land, and a reviewer passes the whole branch before its pull request opens.
```

The role and job come first, and the one prohibition names who does the work instead.

**`roles/reviewer.md`, "What you judge"** (G2, G8)

```text
Style, naming, placement and design fit are the planner's call, so they are not findings.
```

The line keeps the reviewer out of another agent's job, and says whose job it is.

**`roles/planner.md`, "Voice"** (G7)

```text
Reports lead with outcomes: what is now true, what failed, what waits on the Human. Leave out the process narration.
```

The wanted action comes first and is spelled out; the prohibition only trims what is left.

**`roles/planner.md`, "How work flows" > "What a close reports"** (G8, G9)

```text
When the main folder changed, raise it to the Human as a report, the way a merge conflict is shown: each file, whether it was added, changed or deleted, and the command that puts it back. The Human settles it. Never put a file back yourself: the change may be the Human's own.
```

`Never` guards a true invariant, and the line states the reason: the change may be the Human's own.

**`roles/worker.md`, "Finish"** (G8)

```text
Commit the work in the worktree; tmb checks the committed state, not the files on disk.
```

The rule gives its reason in the same sentence.

**`roles/worker.md`, "How you write code"** (G7, G8)

```text
- **Solve the general case.** Never special-case a test's inputs, hard-code its expected output, or edit a test so it passes. When a test or the spec looks wrong, leave it as it is and report it.
```

Each prohibition comes with what to do instead, including the case where the rule seems wrong.

---

## Vendor exemplars

- [Anthropic system prompts](https://platform.claude.com/docs/en/release-notes/system-prompts): how a production prompt orders identity, behavior, and formatting, and how it changes between model versions.
- [Anthropic, Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): keeping the always-loaded context small and loading the rest just in time (G3, G4).
- [Anthropic, Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents): writing tool descriptions and outputs the model can act on, and testing them with evals (G15, G16).

---

## Negative examples

The repo's current prompts are near-clean, so each pair below is `constructed`.

**1. Emphasis on an ordinary rule** — `constructed`, fails G9

- Before: `CRITICAL: You MUST ALWAYS run the linter before committing!!!`
- After: `Run the linter before you commit.`

**2. Bare prohibition** — `constructed`, fails G7

- Before: `Don't write long reports.`
- After: `Keep the report to the return line and at most 4 short lines; put detail in the completion report.`

**3. Persona and tip boilerplate** — `constructed`, fails G10

- Before: `You are a world-class 10x engineer. Take a deep breath. I'll tip $200 for a perfect answer.`
- After: `You are a worker. You carry out one task's spec from the planner in the task's own worktree.`

**4. Duplicated, contradicting rule** — `constructed`, fails G13 and G14

- Before: `Boundaries`: "Commit only when the spec is done." `Workflow`: "Commit after every file you change."
- After: one rule in `Workflow`: "Commit once the spec is done; when you hand back early, commit the work in progress first."

**5. Situational detail in the always-loaded prompt** — `constructed`, fails G3

- Before: a persona that inlines the twelve steps of the release procedure.
- After: `When the Human asks for a release, load the release skill.`

**6. Rule with no reason** — `constructed`, fails G8

- Before: `Read only the line range the brief gives.`
- After: `Read the line range the brief gives, and the whole file only when no range covers what you need, so the context stays short.`

---

## How to use

- **Author:** self-score a prompt change against the Criteria table in the PR description, one line per G-id (pass, fail, or not applicable), and name the eval set and its result for G16.
- **Reviewer:** trust the `deterministic` rows to lints and scripts and spot-check the `judgment` rows against the diff.
