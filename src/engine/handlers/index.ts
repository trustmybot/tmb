// The record's operations by name, each with the input schema it enforces and a description
// telling an agent when to use it. The tool server publishes these as its tools.
import type { Actor, Store } from "../store/index.ts";
import type { InputSchema } from "./input.ts";
import * as op from "./operations.ts";

export type Operation = {
  description: string;
  inputSchema: InputSchema;
  run(store: Store, actor: Actor, input: unknown): unknown;
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
} as const satisfies Record<string, Operation>;

export type OperationName = keyof typeof OPERATIONS;

export function isOperationName(name: unknown): name is OperationName {
  return typeof name === "string" && Object.hasOwn(OPERATIONS, name);
}

export { HandlerError, type HandlerErrorCode } from "./errors.ts";
export { type FieldSchema, type InputSchema } from "./input.ts";
export * from "./operations.ts";
