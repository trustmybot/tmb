// The record's operations by name, each with the input schema it enforces and a description
// telling an agent when to use it. The tool server publishes these as its tools.
import type { Actor, Store } from "../store/index.ts";
import * as feature from "./features.ts";
import * as graph from "./graph.ts";
import type { InputSchema } from "./input.ts";
import * as op from "./operations.ts";
import * as task from "./tasks.ts";

export type Operation = {
  description: string;
  inputSchema: InputSchema;
  /** Returns the result, or a promise of it for an operation that waits, such as running checks. */
  run(store: Store, actor: Actor, input: unknown, context: task.OperationContext): unknown;
};

export const OPERATIONS = {
  issue_create: {
    description:
      "Record a new issue in the project's tmb record when the Human asks to note, file or track work, or when you find work that should not be lost. Returns the issue with its id.",
    inputSchema: op.issueCreateSchema,
    run: op.issueCreate,
  },
  issue_list: {
    description:
      "List the issues in the project's tmb record, newest last, optionally only the open or the closed ones. Use it when the Human asks what work is recorded or open, or before planning new work.",
    inputSchema: op.issueListSchema,
    run: op.issueList,
  },
  issue_get: {
    description:
      "Read one issue from the project's tmb record with all its notes and decisions, and the newest decision, which is the one in force. Use it before working on or discussing an issue.",
    inputSchema: op.issueGetSchema,
    run: op.issueGet,
  },
  issue_update: {
    description:
      "Change an issue in the project's tmb record: close it when its work is done or dropped, reopen it, or change its title, body or milestone. Only the fields you pass change.",
    inputSchema: op.issueUpdateSchema,
    run: op.issueUpdate,
  },
  discussion_append: {
    description:
      "Add a note or a decision to an issue in the project's tmb record. Record a decision whenever the Human and you settle how something will be done; the newest decision replaces the one in force. Use a note for anything else worth keeping.",
    inputSchema: op.discussionAppendSchema,
    run: op.discussionAppend,
  },
  search: {
    description:
      "Search the issues, notes and decisions in the project's tmb record by words, and get ranked snippets. Use it to find earlier work or a past decision before asking the Human again.",
    inputSchema: op.searchSchema,
    run: op.search,
  },
  history: {
    description:
      "Show every recorded change to one issue or discussion entry in the project's tmb record, oldest first, with who made each. Use it to see how an issue reached its current state.",
    inputSchema: op.historySchema,
    run: op.history,
  },
  feature_start: {
    description:
      "Start a feature branch for a milestone's work, before its first task: tmb cuts it from the base branch's latest commit, checking it out nowhere, and records it. Every task is cut from a feature branch and folds back into it when it closes. For the planner.",
    inputSchema: feature.featureStartSchema,
    run: feature.featureStart,
  },
  feature_list: {
    description:
      "List the feature branches in the project's tmb record, each with the base branch and commit it was cut from, its state and the ids of its tasks. Use it before starting a task to see which feature branch it belongs on.",
    inputSchema: feature.featureListSchema,
    run: feature.featureList,
  },
  task_start: {
    description:
      "Start a task on an open issue once its spec is written: its kind (code for a worker, docs for you), the intent, the files it may touch, its success criteria and any checks of its own. tmb cuts the task's branch from the tip of its feature branch, the one named or else the only one open, adds its worktree and returns the brief, with the task_id=<id> line to put in the worker's start prompt. For the planner.",
    inputSchema: task.taskStartSchema,
    run: task.taskStart,
  },
  task_brief: {
    description:
      "Read one task's brief: its spec, its worktree and branch, and every check that must pass before it closes. A worker reads it first and works only in that worktree.",
    inputSchema: task.taskBriefSchema,
    run: task.taskBrief,
  },
  task_close: {
    description:
      "Close a task once its work is committed in its worktree. tmb runs the project's checks and the task's own on the worktree's commit and closes the task only when all pass; otherwise it refuses, naming the failing check and the end of its output. On a pass it folds the commit into the feature branch, first rebasing it and running the checks again when the feature branch moved, removes the task's branch and worktree, and pushes the feature branch to origin as a backup. For the worker or the planner.",
    inputSchema: task.taskCloseSchema,
    run: task.taskClose,
  },
  task_list: {
    description:
      "List the open tasks in the project's tmb record, or the closed ones or all, with each one's state, branch, worktree, files and, once closed, its commit. Use it before starting a task, since two open tasks never share a file.",
    inputSchema: task.taskListSchema,
    run: task.taskList,
  },
  graph_map: {
    description:
      "Show what the project looks like from tmb's code graph: its directories and files, each with a short summary from its README or header, and how many symbols each file defines. Use it at the start of planning instead of listing and opening files.",
    inputSchema: graph.graphMapSchema,
    run: graph.graphMap,
  },
  graph_find: {
    description:
      "Find where something lives in the code: a symbol by name, a file by path, or words matched against symbol names, docs, file and directory summaries. Returns ranked hits with paths and lines. Cheaper than reading files to search them.",
    inputSchema: graph.graphFindSchema,
    run: graph.graphFind,
  },
  graph_symbol: {
    description:
      "Look up a symbol, or a file by its path, in the code graph: where it is defined, what calls or imports it, what it calls, and which tests cover it. References are linked only on proof; the rest are listed as unresolved. Use it before changing something, to see what the change may break.",
    inputSchema: graph.graphSymbolSchema,
    run: graph.graphSymbol,
  },
  graph_scope: {
    description:
      "Draft a task's scope from the code graph: from an objective and any anchors (symbols or files), the files in scope with why each is there (search, anchor, caller, import), the tests that cover them, the concepts anchored there, and a draft list of files for task_start. For the planner, before task_start, instead of reading files.",
    inputSchema: graph.graphScopeSchema,
    run: graph.graphScope,
  },
  graph_concept_upsert: {
    description:
      "Record a concept in the code graph: a flow or a rule, anchored to the files and symbols that carry it out, so later sessions find the design behind the code. Anchors must exist in the base branch. A rebuild re-checks each concept and marks one whose code is gone as broken.",
    inputSchema: graph.graphConceptUpsertSchema,
    run: graph.graphConceptUpsert,
  },
  graph_concepts: {
    description: "List the concepts recorded in the code graph, or read one by name, with each one's anchors and whether its code still exists.",
    inputSchema: graph.graphConceptsSchema,
    run: graph.graphConcepts,
  },
  graph_miss: {
    description:
      "Report a code graph lookup that answered wrong or missed something you then found another way, so the graph's value can be measured. Lookups that find nothing are recorded on their own.",
    inputSchema: graph.graphMissSchema,
    run: graph.graphMiss,
  },
} as const satisfies Record<string, Operation>;

export type OperationName = keyof typeof OPERATIONS;

export function isOperationName(name: unknown): name is OperationName {
  return typeof name === "string" && Object.hasOwn(OPERATIONS, name);
}

export { HandlerError, type HandlerErrorCode } from "./errors.ts";
export { type FieldSchema, type InputSchema } from "./input.ts";
export * from "./features.ts";
export * from "./graph.ts";
export { type PushOutcome, type PushResult } from "./fold.ts";
export * from "./operations.ts";
export * from "./tasks.ts";
