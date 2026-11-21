# Agent responsibilities

What each tmb role is for, what it may and may not do, and why the roles are split this way. Each role's prompt sits in its own role file, written once in a host-neutral form; the engine's role checks sit in the code. Ask the code graph for either.

| Role | Who | Plugin name |
|---|---|---|
| Human | The developer | Human |
| Planner, addressed as bro | The host's main agent | bro |
| Worker | A subagent the host starts | swe |
| Reviewer | A subagent the host starts, or a second host set up as the reviewer | code-reviewer |

```mermaid
flowchart LR
    H["Human<br/>goal, review mode, waiver, merge"] --> P["Planner (bro)<br/>issue, spec, design fit, pull request"]
    P -- "starts, with a task" --> W["Worker<br/>code in the task's worktree"]
    P -- "starts, with a branch or task" --> R["Reviewer<br/>verdict, no edits"]
    W -- "close: checks" --> E[Engine]
    R -- verdict --> E
    P -- tools --> E
    E --> G["git, checks, pull requests"]
```

## Why three roles

Two things decide the split: what each role can be trusted to do without approving its own work, and which role keeps working when something unexpected happens.

- **The planner** holds the full picture: the system design and alignment with the Human. It does everything except coding, is the only agent that talks to the Human, and owns the plan, the spec and the design call.
- **The worker** codes, split out for three reasons:
  1. **Token cost.** Coding in the planner would fill its strategic context with diff noise.
  2. **No self-homework.** The engine runs the spec's checks on the worker's commit at close. The agent that writes the code does not sign it off.
  3. **Subagents are fragile.** A worker runs with a fresh context, and its run can end at any point. The plan, the spec and the pull request stay with the planner, the most resilient layer.
- **The reviewer** is an independent third party before the push, with no edit tools. Its verdict, or a Human waiver, is the only thing the push gate accepts.

Each layer owns one level of quality, and no layer repeats another's check: the Human owns intent, the planner the spec and design fit, the worker functionality, and the reviewer the diff. [TASKS.md](TASKS.md#quality-layers) shows how the layers hand off.

## Which agents a project has

- **Workflow backbone, always available.** The worker and the reviewer ship with tmb. Init writes them into the project in the host's own format, and removal deletes exactly those files. tmb replaces only role files it wrote; a file of the same name that is not tmb's is left alone.
- **The host starts them.** tmb starts no agent, runs no model and never reads a login. The work runs as ordinary use of the host by its own user ([HOSTS.md](HOSTS.md)).
- **Consultants, opt-in per project.** Open, for the Human. The plugin drafts one per project from a generic scaffold; tmb has built none ([EXTENDING.md](EXTENDING.md)).

A role's file is its identity and the start prompt is the task context. Skills as added capabilities are Planned: tmb ships none yet.

## Planner (bro)

The persona is not a role file: the engine gives it to the host's main agent at every session start, with the rules and the open work from the record. In an unattended run it puts one instruction first: apply your defaults and name each one.

- **Plans and routes.** Records the goal as an issue, scopes the work from the code graph, names the feature branch, writes the task spec, and asks the engine to start the task.
- **Judges, re-checks nothing.** After the review passes it judges only whether the change fits the design, and whether the files changed outside the spec should have been touched. It runs no check again and reviews no diff again.
- **Asks for the pull request.** It reads the verdict from the record, never from reply text, and asks the engine to push and open the pull request. It never pushes or opens one by hand.
- **Writes only docs tasks.** A change to docs or prompts that changes no behaviour is a docs task the planner writes itself in that task's worktree. Nothing stops an edit on the way; the close refuses a docs task whose commit touches a file that is not a docs type, and the reviewer sees it with the rest ([TASKS.md](TASKS.md#32-non-code-task)).
- **Keeps the code graph's knowledge.** It records the flows and rules that span files, and proposes the project's areas to the Human. Only the planner writes or removes an area.
- **Talks to the Human.** Only the planner asks the Human questions and reports to them. It raises main-folder changes as a report and never puts a file back itself.
- **Never takes the Human's steps.** Setting the review mode, waiving a review and removing tmb are the Human's alone. The planner stores the Human's answer and never picks one.
- **Runs parallel sessions with its prompt and tools.** tmb keeps no lane record ([LANES.md](LANES.md)).

## Worker

- **Started for one open task.** The gate denies a start whose prompt names no open task with a ready worktree. The worker reads its brief first.
- **Works in the worktree only.** It edits, tests and commits on the task branch, and never in the main folder. Where the host gives each worker a folder of its own, the engine adopts that folder as the task's worktree when the worker first reads its brief.
- **Keeps to the spec, and says when it could not.** When the work needs a file outside the spec, it changes it and names it in its report. The close names every such file for the planner or the reviewer to check.
- **Closes with the checks.** It runs the brief's checks, commits, and asks the engine to close. A refused close names what failed; the worker fixes it and closes again.
- **Reports against every success criterion,** with the command or output that shows it, what it did not verify, and what the planner must decide.
- **Stops and reports instead of guessing:** on a contradictory spec, a missing fact, or three failed attempts at one approach. A deny by the gate is a hard stop on that action; it reaches that effect no other way.
- **Hands back.** Planned: when the work will not fit its turns, it commits a checkpoint so the next run resumes.

## Reviewer

- **Agile: once per feature branch.** Tasks close and fold without a verdict of their own, code and docs alike, and the reviewer judges the whole branch at its tip before its pull request opens ([AGILE.md](AGILE.md)).
- **Truest: once per task,** on the task's commit, before that task's pull request opens.
- **Judges what the diff breaks.** A success criterion, a caller or reader of the changed code, a security property, a stated performance budget. Style, naming and design fit are the planner's call, not findings.
- **Reviews from the record and its own probes.** It reads the branch's and each task's brief, asks the code graph what calls or reads each changed thing, and probes with read-only commands.
- **Signs off with a recorded verdict:** pass or fail on the exact commit, each finding marked blocking, not blocking, or already there. A verdict needs the reviewer run the host started; a verdict on a tip that has moved is not taken.
- **Never edits files,** never pushes and never opens a pull request.

## Consultants

Open, for the Human: tmb has not built consultants, and whether it carries them over is not decided. The plugin's rules, kept as the design:

- **Cannot write workflow state.** Their issue, task, status and verdict writes are refused.
- **Write analyses** as discussion notes.
- **Advise, never decide.** The planner reports their analysis to the Human, and the Human decides.

## How roles are enforced

The host keeps each role in bounds, through files the adapter writes. tmb has no hook that checks a caller's role on every tool call.

```mermaid
flowchart TD
    A["Roles: written once, host-neutral<br/>worker: read, edit, run commands<br/>reviewer: read, run commands"] --> B["Host adapter, at init"]
    B --> C["Role files in the host's own format<br/>with the tools each role must never use taken away"]
    C --> D["The host enforces the tool list itself"]
    B --> E["Event wiring: agent start and stop, reviewer file write, session start"]
    E --> F["Engine answers allow or deny from the record"]
    D --> G["Whatever got past: checks at close, the review, git's pre-push hook"]
    F --> G
```

- **A role file takes away only what the role must never use.** The reviewer is given no tool that edits a file. The worker loses nothing. Every other tool, a project's own included, stays.
- **The adapter holds no rules.** It turns the neutral role into the host's format, and a host event into the engine's question. An adapter that grows a rule is a defect.
- **The engine's tools check the role too.** Starting a feature branch or a task, dropping one, asking for a pull request and changing a setting are the planner's. Recording a verdict is the reviewer's. Closing a task is the worker's or the planner's. The Human may always call.
- **The role is the one the caller gives.** A subagent passes its own role; the main agent defaults to the role its host was set up in, the planner unless init or onboarding named another. tmb cannot prove which agent called, so a verdict also needs an open reviewer run on that host.
- **What holds differs by host** (trustmybot/tmb#185):

| Host | Reviewer's edit tools | A write that reaches the gate | From the shell |
|---|---|---|---|
| Claude Code | Taken away by its role file | Denied: the host names the subagent on each call | Not read by tmb. A push is still judged by git's hook |
| Codex (built, not supported or tested before v2) | Taken away by its role file | A reviewer subagent's write goes through: the host names no agent on a call. A Codex set up as the reviewer is denied on every write | A patch run through the shell is denied for a reviewer host. A push is still judged by git's hook |

- **A model per role.** The adapter writes a role's model and effort into its role file when one is set; the host runs it.
- **The Human's steps have two fences** (trustmybot/tmb#179): the command line asks for a terminal and a typed yes, and the gate denies an agent's shell command that takes such a step. They stop an agent on the plain path and record each deny. They are not proof.
- **When a host cannot deny an action,** the engine's own layers still hold: checks at close and git's pre-push hook.
