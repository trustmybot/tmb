# Extending the team

Every case of flows 4.2 to 4.4 in [FLOWS.md](FLOWS.md): how a project gains agents, skills and second opinions, and what each path refuses. Acquiring a published capability (flow 4.1) is in [CHEATCODES.md](CHEATCODES.md); what each agent may do once it exists is in [RESPONSIBILITIES.md](RESPONSIBILITIES.md).

Today tmb ships three roles and no skill. Everything else on this page is Planned or Open ([Shipped and planned](#shipped-and-planned)).

## 4.2 Agent creation

**Open, for the Human:** whether tmb carries the plugin's agent creation over. The plugin's design, in tmb's words:

```mermaid
flowchart TD
    A[Routing hits a role with no agent] --> B{Name allowed?}
    B -- "planner, bro, worker or reviewer" --> X[Refused]
    B -- a project agent of that name exists --> T{tmb wrote it?}
    T -- yes --> U["Show the diff; the Human says yes or no"]
    T -- no --> V["The Human picks skip, adopt or overwrite; skip is the default"]
    U -- yes --> W
    V -- adopt or overwrite --> W
    U -- no --> Z
    V -- skip --> Z
    B -- new --> Q[Up to three clarifying questions]
    Q --> D[Tailored draft]
    D --> H{Human approves?}
    H -- revise --> D
    H -- no --> Z["Draft discarded; nothing is written"]
    H -- yes --> W[Role recorded; each adapter writes it for its host]
    W --> R["Later sessions route to it; the files stay local to this checkout"]
```

The planner, worker and reviewer names are refused because a project copy would shadow the workflow backbone.

- **Every draft starts from one generic scaffold.** There is no per-role template; the clarifying questions tailor the draft.
- **An approval covers one file and lapses.** A draft approved but not written within a short window needs a new approval.
- **tmb never touches an agent file it did not write.** Shipped: setup leaves such a file alone and says so, and replaces only its own.
- **A backbone role is never copied.** Attaching a skill or a cheatcode to the worker or the reviewer extends that role's lists; the adapters write the result.

## 4.3 Skill creation

**Planned.** tmb has no skills yet.

```mermaid
flowchart TD
    A[Recurring pattern] --> D[The planner drafts the skill]
    D -- the name is already registered --> Q2["The Human picks another name, or edits the existing skill"]
    Q2 --> D
    D --> H{Human approves?}
    H -- revise --> D
    H -- no --> Z["Draft discarded; nothing is written"]
    H -- yes --> S[Skill lands in the project]
    S --> O[Attached to a role; each adapter writes it for its host]
```

The planner never edits a role's prompt; attaching a skill only extends the role's skill list. A skill is attached to a role once and reaches every host in that role. The attach step also takes a skill the Human downloaded.

## tmb's own skills

**Planned; must ship.** tmb ships its own skills, as the plugin shipped 13. A skill is loaded on demand, so the always-loaded role text stays short. Today each procedure sits in a role's text.

```mermaid
flowchart LR
    R["Role text: always loaded, short"] --> T{A skill's trigger fires?}
    T -- no --> W[Work goes on with the role text alone]
    T -- yes --> L[The role loads that skill]
    L --> P[The skill carries the procedure]
```

- Skills are written once, host-neutral, like the roles. Each adapter writes them in its host's format.
- New for tmb: a search skill. It teaches the planner to search with several word queries and to follow the code graph.

What the plugin shipped, in tmb's words. **Open, for the Human:** which of these tmb keeps, and under what names.

| Skill | Loaded by | When |
|---|---|---|
| Planning | Planner | The first code task of a session: scope, spec, start the worker, hand off to review. |
| Spec authoring | Planner | Each turn that writes a spec; raises effort for it. |
| Push gate | Planner | A push is refused, the Human asks for a review, or a milestone is reached. |
| Comment triage | Planner | Review comments reach a pull request it owns. Depends on triage, Planned. |
| Recovery | Planner | A tool or the tool server fails. |
| Concerns protocol | Planner | It disagrees with the Human's plan. |
| Audit | Planner | The Human asks for an audit or an architecture review. |
| Cheatcode | Planner | A task needs a capability the project lacks. Depends on [cheatcodes](CHEATCODES.md), Planned. |
| Skill creator | Planner | The Human asks to capture a repeatable behaviour ([4.3](#43-skill-creation)). |
| Docs conventions | Any role | Editing prompts or docs. |
| Doc review | Any role | Checking a change to prompts or docs. |
| Worker checklist | Worker | Its self-review before close. |
| Review | Reviewer | Judging a diff and recording the verdict. |

## 4.4 Consultant invocation

**Open, for the Human:** whether tmb carries consultants over. The plugin's design, in tmb's words:

```mermaid
flowchart TD
    A[Human asks for a second opinion] --> C{Role exists?}
    C -- yes --> S[The host starts the consultant on the question]
    C -- no --> F["Flow 4.2: draft, the Human approves, write and record"]
    F -- approved --> S
    F -- rejected --> Z["No consultant; the planner answers the question itself and says so"]
    S --> R["Analysis recorded on the issue, checked when it stops"]
    R --> B["The planner reports; the Human decides"]
```

The consultant never decides and never writes workflow state. The planner judges when a question fits a consultant: tmb's hooks are checkpoints, so nothing injects a routing hint on each prompt.

## Shipped and planned

| Part | State |
|---|---|
| Three roles, written once and written to each host by its adapter | Shipped |
| Setup leaves an agent file tmb did not write alone | Shipped |
| tmb's own skills | Planned; must ship |
| Skill creation and attachment to a role | Planned |
| Cheatcodes | Planned (trustmybot/tmb#112) |
| Agent creation | Open, for the Human |
| Consultants | Open, for the Human |
| Roundtable | Not carried over |
