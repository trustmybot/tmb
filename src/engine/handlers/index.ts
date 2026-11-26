// The record's operations by name, each with the input schema it enforces and a description
// telling an agent when to use it. The tool server publishes these as its tools.
import { runningName } from "../../program.ts";
import type { Actor, Store } from "../store/index.ts";
import * as feature from "./features.ts";
import * as feedback from "./feedback.ts";
import * as graph from "./graph.ts";
import type { InputSchema } from "./input.ts";
import * as op from "./operations.ts";
import * as review from "./reviews.ts";
import * as settings from "./settings.ts";
import * as task from "./tasks.ts";
import * as truest from "./truest.ts";

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
      "Start a feature branch for a milestone's work, before its first task: tmb cuts it from the base branch's latest commit, fetched from origin first unless the local base branch is ahead of it, checking it out nowhere, and records it. Every task is cut from a feature branch and folds back into it when it closes. For the planner.",
    inputSchema: feature.featureStartSchema,
    run: feature.featureStart,
  },
  feature_update: {
    description:
      "Bring the base branch into a feature branch: tmb fetches the base from origin (the local one when it is ahead or there is no origin), merges it into the branch with a merge commit, never a rebase, and pushes the branch as a backup. Call it before you start the reviewer on the branch, and earlier whenever the base moved. A conflict changes nothing and names the files: settle it in a task on the branch, or raise it to the Human. For the planner.",
    inputSchema: feature.featureUpdateSchema,
    run: feature.featureUpdate,
  },
  feature_drop: {
    description:
      "End a feature branch without a merge tmb saw, with the reason: one nobody will merge, or one whose work reached the base branch in a way tmb cannot tell (say where it went). An open, closed or ready branch is dropped; one whose pull request is open is refused, since GitHub could still merge it: the Human closes the pull request first. Refused while a task on it is open or in review. The branch is kept, and the answer says how to delete it. A dropped branch takes no task and opens no pull request. For the planner and the Human.",
    inputSchema: feature.featureDropSchema,
    run: feature.featureDrop,
  },
  feature_list: {
    description:
      "List the feature branches in the project's tmb record, each with the base branch and commit it was cut from, its state and the ids of its tasks. A feature branch in pr_open whose pull request merged or closed moves to merged or closed first, read through the Human's GitHub command line; a ready one (a repo with no remote) moves to merged once the local base branch holds its tip. Use it before starting a task to see which feature branch it belongs on.",
    inputSchema: feature.featureListSchema,
    run: feature.featureList,
  },
  feature_brief: {
    description:
      "Read a feature branch's review brief: where it leaves the base branch, its tip, each task's commits on it as the groups to review in, every review and Human waiver, and whether a pass or a waiver covers the tip. The reviewer reads it first; the planner reads it before feature_pr.",
    inputSchema: review.featureBriefSchema,
    run: review.featureBrief,
  },
  review_record: {
    description:
      "Record your verdict on a feature branch at the commit you reviewed, its tip: pass when no finding blocks, fail with each blocking finding. A review counts only for that commit, so a branch that moves needs a new one. For the reviewer.",
    inputSchema: review.reviewRecordSchema,
    run: review.reviewRecord,
  },
  feature_waive: {
    get description() {
      return `Waive the review of a feature branch at its tip, with the reason, so its pull request may open unreviewed. Only the Human waives, from the command line (\`${runningName()} feature waive <name> --reason <text>\`); an agent is refused.`;
    },
    inputSchema: review.featureWaiveSchema,
    run: review.featureWaive,
  },
  feature_pr: {
    description:
      "Open the one pull request of a feature branch into the base branch, once the reviewer passed the branch at its tip or the Human waived the review: tmb pushes the branch to origin and opens the pull request with the GitHub command line. In a repo with no remote nothing is pushed and no pull request opens: the branch is recorded ready, and the answer gives the Human the command to merge it locally. Refused while neither covers the tip. For the planner.",
    inputSchema: review.featurePrSchema,
    run: review.featurePr,
  },
  task_start: {
    description:
      "Start a task on an open issue once its spec is written: its kind (code for a worker, docs for you), the intent, the files it may touch, its success criteria and any checks of its own. tmb cuts the task's branch from the tip of its feature branch, the one named or else the only one open (in truest mode, from the base branch), adds its worktree and returns the brief, with the task_id=<id> line to put in the worker's start prompt, and the open tasks that share one of its files, as information: git merges changes to different lines, and a clash on the same lines reopens the later task. For the planner.",
    inputSchema: task.taskStartSchema,
    run: task.taskStart,
  },
  task_brief: {
    description:
      "Read one task's brief: its spec, its worktree and branch, and every check that must pass before it closes. A worker reads it first and works only in that worktree, in its project folder, which is the worktree unless the project is below its repo's top.",
    inputSchema: task.taskBriefSchema,
    run: task.taskBrief,
  },
  task_close: {
    description:
      "Close a task once its work is committed in its worktree. tmb runs the project's checks and the task's own on the worktree's commit and closes the task only when all pass; otherwise it refuses, naming the failing check and the end of its output. On a pass it folds the commit into the feature branch, first rebasing it and running the checks again when the feature branch moved, removes the task's branch and worktree, and pushes the feature branch to origin as a backup. In truest mode a pass instead leaves the task in review at its commit, worktree kept, for the reviewer and then task_pr. For the worker or the planner.",
    inputSchema: task.taskCloseSchema,
    run: task.taskClose,
  },
  task_review: {
    description:
      "Record your verdict on a truest task at the commit you reviewed, the one its brief shows: pass when no finding blocks, fail with each blocking finding. A fail reopens the task for its worker. A review counts only for that commit. For the reviewer.",
    inputSchema: truest.taskReviewSchema,
    run: truest.taskReview,
  },
  task_waive: {
    get description() {
      return `Waive the review of a truest task at its commit, with the reason, so its pull request may open unreviewed. Only the Human waives, from the command line (\`${runningName()} task waive <id> --reason <text>\`); an agent is refused.`;
    },
    inputSchema: truest.taskWaiveSchema,
    run: truest.taskWaive,
  },
  task_pr: {
    description:
      "Open a truest task's own pull request into the base branch, once the reviewer passed it at its commit or the Human waived the review. When the base branch moved, tmb first rebases the task onto it and runs the checks again: an unchanged patch keeps its review, a changed one needs a new review, a conflict reopens the task. Then tmb pushes the task's branch and opens the pull request with the GitHub command line. In a repo with no remote nothing is pushed and no pull request opens: the task is recorded ready, its worktree goes and its branch stays, and the answer gives the Human the command to merge it locally. For the planner.",
    inputSchema: truest.taskPrSchema,
    run: truest.taskPr,
  },
  task_drop: {
    get description() {
      return `Drop a task whose approach is wrong or that nobody will finish, with the reason: it ends without its work, as an open task or a truest task in review. tmb removes its worktree as at a close, unless it holds work nobody committed, and keeps its branch while that holds commits. A new task can name it in task_start's replaces. For the planner, or the Human (\`${runningName()} task drop <id> --reason <text>\`).`;
    },
    inputSchema: task.taskDropSchema,
    run: task.taskDrop,
  },
  task_list: {
    description:
      "List the open tasks in the project's tmb record, or those in review, the ready ones (waiting for the Human's local merge in a repo with no remote; one the base branch holds moves to closed first), the closed ones, the dropped ones or all, with each one's state, branch, worktree, files and, once closed, its commit. Use it before starting a task to see which open tasks hold the same files.",
    inputSchema: task.taskListSchema,
    run: task.taskList,
  },
  settings_get: {
    description:
      "Read the project's settings (base branch, review mode, checks, each host's role), which of the project settings are still empty, and what tmb detects in the project as a start for a recommendation. Use it before settings_set.",
    inputSchema: settings.settingsGetSchema,
    run: settings.settingsGet,
  },
  settings_set: {
    description:
      "Set one or more of the project's settings: the base branch, the review mode, the checks. Use it when a session starts with the settings empty, to apply the ones you recommend for this project, and when the Human asks to change one. Only the settings you pass change. For the planner.",
    inputSchema: settings.settingsSetSchema,
    run: settings.settingsSet,
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
      "Look up a symbol, or a file by its path, in the code graph: where it is defined, what calls or imports it, what it calls, and which tests cover it. References are linked only on proof; the rest are listed as unresolved. Its calls are counted by state: linked to the repo's code, outside the repo (built-ins and packages), and not known. Use it before changing something, to see what the change may break.",
    inputSchema: graph.graphSymbolSchema,
    run: graph.graphSymbol,
  },
  graph_scope: {
    description:
      "Draft a task's scope from the code graph: from an objective and any anchors (symbols or files), the files in scope with why each is there (search, anchor, caller, import), the tests that cover them, the concepts anchored there, and a draft list of files for task_start. With no task_id or feature, it reads the repo's feature branch when exactly one is open, since the task is cut from there; the answer's freshness says which. For the planner, before task_start, instead of reading files.",
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
  graph_area_upsert: {
    description:
      "Write an area of the project: a logical part such as login, billing or the dashboard, as path patterns of the files it holds and leaves out, with a one-line purpose. Every file and symbol card then names its areas, and graph_find and graph_scope can keep to an area or leave one out. A pattern that matches no file is refused. \"tests\" is built in. For the planner, at onboarding and when the project's parts change.",
    inputSchema: graph.graphAreaUpsertSchema,
    run: graph.graphAreaUpsert,
  },
  graph_area_remove: {
    description: "Remove an area of the project that no longer fits, by name. \"tests\" is built in and stays. For the planner.",
    inputSchema: graph.graphAreaRemoveSchema,
    run: graph.graphAreaRemove,
  },
  graph_areas: {
    description:
      "List the project's areas, each with its patterns, how many files it holds and whether it still matches (a rebuild marks one whose files are gone as broken, and one whose size moved by more than a quarter for review), and the files in no area with their count.",
    inputSchema: graph.graphAreasSchema,
    run: graph.graphAreas,
  },
  graph_miss: {
    description:
      "Report a code graph lookup that answered wrong or missed something you then found another way, so the graph's value can be measured. Lookups that find nothing are recorded on their own.",
    inputSchema: graph.graphMissSchema,
    run: graph.graphMiss,
  },
  feedback_draft: {
    description:
      "Draft a bug report about tmb itself when tmb breaks: a tmb tool or command failed in a way that looks like tmb's fault, not the project's. tmb fills in its version, the OS, the host, the error and the kinds of recent record events, cleans paths and secrets, and returns the whole report without sending it. Refused when the feedback program is off. For the planner.",
    inputSchema: feedback.feedbackDraftSchema,
    run: feedback.feedbackDraft,
  },
  feedback_send: {
    description:
      "Send a report feedback_draft drafted, only after the Human read the whole draft and said yes to it: it becomes a public issue on tmb's repo from their GitHub account, or opens the filled-in bug form for them to submit. Refused without the Human's yes and in a run where no one can answer. For the planner.",
    inputSchema: feedback.feedbackSendSchema,
    run: feedback.feedbackSend,
  },
} as const satisfies Record<string, Operation>;

export type OperationName = keyof typeof OPERATIONS;

export function isOperationName(name: unknown): name is OperationName {
  return typeof name === "string" && Object.hasOwn(OPERATIONS, name);
}

export { HandlerError, type HandlerErrorCode } from "./errors.ts";
export { type FieldSchema, type InputSchema } from "./input.ts";
export * from "./features.ts";
export * from "./feedback.ts";
export * from "./graph.ts";
export * from "./marks.ts";
export { type PushOutcome, type PushResult } from "./fold.ts";
export * from "./operations.ts";
export * from "./reviews.ts";
export * from "./settings.ts";
export * from "./tasks.ts";
export * from "./truest.ts";
