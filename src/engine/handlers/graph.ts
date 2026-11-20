// The code graph's operations: the project map, where X lives, what depends on X, the scope of
// a task, and the concepts. Each read first brings the graph forward to the base branch; with a
// task_id it reads that task's commit, and with a feature that feature branch's tip.
import { CONCEPT_KINDS, type Concept, type ConceptKind, getConcept, listConcepts, parseAnchor, upsertConcept } from "../graph/concepts.ts";
import { openGraphDb } from "../graph/db.ts";
import { type Freshness, type GraphView, openView, type ViewTarget } from "../graph/fresh.ts";
import { FIND_MAX, find, type Hit, lookupSymbol, type MapResult, projectMap, recordMiss, scope, type ScopeResult, type SymbolCard } from "../graph/lookups.ts";
import { UNTRUSTED_NOTE } from "../graph/summary.ts";
import type { Actor, Store } from "../store/index.ts";
import type { OperationContext } from "./common.ts";
import { resolveRepo } from "../repos.ts";
import { HandlerError } from "./errors.ts";
import { type FieldSchema, type InputSchema, NOT_BLANK, RECORD_ID, validateInput } from "./input.ts";

/** Every graph answer says what it was answered from and that its text is data. */
export type GraphAnswer<T> = T & { freshness: Freshness; untrusted: string };

const TASK_ID: FieldSchema = {
  type: "string",
  description:
    "Read as this task sees the code: an open task's commit, or, once its work is folded into a feature branch that is still open, that branch's tip. Leave out to read the base branch.",
  pattern: RECORD_ID,
};

const FEATURE: FieldSchema = {
  type: "string",
  description: "Read a feature branch at its tip, by its name as feature_list shows it: the work already folded into it included. Not with task_id.",
  pattern: NOT_BLANK,
};

const REPO: FieldSchema = {
  type: "string",
  description: "In a workspace of several repos, the repo whose graph to read, by its name in the workspace (settings_get lists them). With task_id, the task's repo. Omit it in a project of one repo.",
  pattern: NOT_BLANK,
};


type Miss = (lookup: string, query: string, detail?: string) => void;

/**
 * Answers one read from a graph brought forward first. The read runs in one transaction, so
 * every statement of an answer sees the same build even while another process brings the
 * graph forward; misses it notes are recorded after it. Pass `writes` when the read writes.
 */
async function withView<T>(
  store: Store,
  actor: Actor,
  context: OperationContext,
  target: ViewTarget,
  read: (view: GraphView, miss: Miss) => T,
  writes = false,
): Promise<GraphAnswer<T>> {
  const view = await openView(context.projectDir, store, target);
  try {
    const misses: Parameters<Miss>[] = [];
    // A write takes the lock up front: a read transaction that later writes fails when another process committed in between.
    const transaction = view.db.transaction(() => read(view, (...miss) => misses.push(miss)));
    const answer = writes ? transaction.immediate() : transaction.deferred();
    for (const [lookup, query, detail] of misses) recordMiss(view.db, actor, lookup, query, detail);
    return { ...answer, freshness: view.freshness, untrusted: UNTRUSTED_NOTE };
  } finally {
    view.db.close();
  }
}

// --- graph_map ----------------------------------------------------------------------------

export const graphMapSchema: InputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "The directory to start from, relative to the project; the whole project when left out." },
    depth: { type: "integer", description: "How many directory levels to show, the start included; 2 when left out.", minimum: 1, maximum: 20 },
    task_id: TASK_ID,
    feature: FEATURE,
    repo: REPO,
  },
  required: [],
  additionalProperties: false,
};

export async function graphMap(store: Store, actor: Actor, input: unknown, context: OperationContext): Promise<GraphAnswer<MapResult>> {
  const { path, depth, task_id, feature, repo } = validateInput<{ path?: string; depth?: number; task_id?: string; feature?: string; repo?: string }>("graph_map", graphMapSchema, input);
  return withView(store, actor, context, { taskId: task_id, feature, repo }, (view) => projectMap(view.db, view.layer, { path, depth }));
}

// --- graph_find ---------------------------------------------------------------------------

export const graphFindSchema: InputSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "A symbol's name, a path, or words that describe what you look for.", pattern: NOT_BLANK },
    k: { type: "integer", description: `How many hits to return; 10 when left out.`, minimum: 1, maximum: FIND_MAX },
    task_id: TASK_ID,
    feature: FEATURE,
    repo: REPO,
  },
  required: ["query"],
  additionalProperties: false,
};

export async function graphFind(store: Store, actor: Actor, input: unknown, context: OperationContext): Promise<GraphAnswer<{ hits: Hit[] }>> {
  const { query, k, task_id, feature, repo } = validateInput<{ query: string; k?: number; task_id?: string; feature?: string; repo?: string }>("graph_find", graphFindSchema, input);
  return withView(store, actor, context, { taskId: task_id, feature, repo }, (view, miss) => {
    const hits = find(view.db, view.layer, query, k);
    if (hits.length === 0) miss("graph_find", query);
    return { hits };
  });
}

// --- graph_symbol -------------------------------------------------------------------------

export const graphSymbolSchema: InputSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "A symbol's name or qualified name (Class.method), or a file's path for what depends on the file.", pattern: NOT_BLANK },
    path: { type: "string", description: "Only the symbol defined in this file, when several share the name." },
    task_id: TASK_ID,
    feature: FEATURE,
    repo: REPO,
  },
  required: ["name"],
  additionalProperties: false,
};

export async function graphSymbol(
  store: Store,
  actor: Actor,
  input: unknown,
  context: OperationContext,
): Promise<GraphAnswer<{ cards: SymbolCard[]; more: number }>> {
  const { name, path, task_id, feature, repo } = validateInput<{ name: string; path?: string; task_id?: string; feature?: string; repo?: string }>("graph_symbol", graphSymbolSchema, input);
  return withView(store, actor, context, { taskId: task_id, feature, repo }, (view, miss) => {
    const result = lookupSymbol(view.db, view.layer, name, path);
    if (result.cards.length === 0) miss("graph_symbol", path === undefined ? name : `${path}#${name}`);
    return result;
  });
}

// --- graph_scope --------------------------------------------------------------------------

export const graphScopeSchema: InputSchema = {
  type: "object",
  properties: {
    objective: { type: "string", description: "What the task should achieve, in a few words; seeds the search. May be empty when anchors are given." },
    anchors: {
      type: "array",
      description: "Symbols (name, Class.method or path#name) or file paths the task is about. Each adds its callers, importers and tests.",
      items: { type: "string", pattern: NOT_BLANK },
    },
    k: { type: "integer", description: "How many search hits to seed from; 8 when left out.", minimum: 1, maximum: FIND_MAX },
    task_id: TASK_ID,
    feature: FEATURE,
    repo: REPO,
  },
  required: [],
  additionalProperties: false,
};

export async function graphScope(store: Store, actor: Actor, input: unknown, context: OperationContext): Promise<GraphAnswer<ScopeResult>> {
  const { objective = "", anchors = [], k, task_id, feature, repo } = validateInput<{ objective?: string; anchors?: string[]; k?: number; task_id?: string; feature?: string; repo?: string }>(
    "graph_scope",
    graphScopeSchema,
    input,
  );
  if (objective.trim() === "" && anchors.length === 0) throw new HandlerError("invalid_input", "graph_scope needs an objective or at least one anchor");
  return withView(store, actor, context, { taskId: task_id, feature, repo, defaultToFeature: true }, (view, miss) => {
    const result = scope(view.db, view.layer, { objective, anchors, k });
    for (const anchor of result.unresolvedAnchors) miss("graph_scope", anchor, "anchor not found");
    if (result.files.length === 0 && result.tests.length === 0) miss("graph_scope", objective, "nothing in scope");
    return result;
  });
}

// --- graph_concept_upsert -----------------------------------------------------------------

export const graphConceptUpsertSchema: InputSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "The concept's name; writing a name that exists replaces that concept.", pattern: NOT_BLANK },
    kind: { type: "string", description: "flow: how something moves through the code. rule: something the code must always hold.", enum: CONCEPT_KINDS },
    body: { type: "string", description: "The flow or rule in a few sentences, naming the design page it carries out, if any.", pattern: NOT_BLANK },
    anchors: {
      type: "array",
      description: "The files (path) and symbols (path#QualifiedName) that carry it out, in order. Each must be in the graph of the base branch.",
      items: { type: "string", pattern: NOT_BLANK },
      minItems: 1,
    },
    repo: REPO,
  },
  required: ["name", "kind", "body", "anchors"],
  additionalProperties: false,
};

export async function graphConceptUpsert(store: Store, actor: Actor, input: unknown, context: OperationContext): Promise<GraphAnswer<{ concept: Concept }>> {
  const { name, kind, body, anchors, repo } = validateInput<{ name: string; kind: ConceptKind; body: string; anchors: string[]; repo?: string }>(
    "graph_concept_upsert",
    graphConceptUpsertSchema,
    input,
  );
  return withView(store, actor, context, { repo }, (view) => {
    const result = upsertConcept(view.db, actor, { name, kind, body, anchors: anchors.map(parseAnchor) }, view.freshness.commit);
    if (result.concept === null) {
      throw new HandlerError("refused", `a concept is anchored only to code in the graph, and these are not in the base branch: ${result.missing.join(", ")}`);
    }
    return { concept: result.concept };
  }, true);
}

// --- graph_concepts -----------------------------------------------------------------------

export const graphConceptsSchema: InputSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "One concept by its name or id." },
    query: { type: "string", description: "Only concepts whose name or body holds each of these words." },
    repo: REPO,
  },
  required: [],
  additionalProperties: false,
};

export async function graphConcepts(store: Store, actor: Actor, input: unknown, context: OperationContext): Promise<GraphAnswer<{ concepts: Concept[] }>> {
  const { name, query, repo } = validateInput<{ name?: string; query?: string; repo?: string }>("graph_concepts", graphConceptsSchema, input);
  return withView(store, actor, context, { repo }, (view) => {
    if (name === undefined) return { concepts: listConcepts(view.db, query) };
    const concept = getConcept(view.db, name);
    if (concept === null) throw new HandlerError("not_found", `no concept ${JSON.stringify(name)} in the code graph`);
    return { concepts: [concept] };
  });
}

// --- graph_miss ---------------------------------------------------------------------------

export const GRAPH_LOOKUPS = ["graph_map", "graph_find", "graph_symbol", "graph_scope"] as const;

export const graphMissSchema: InputSchema = {
  type: "object",
  properties: {
    lookup: { type: "string", description: "The lookup that answered wrong or missed.", enum: GRAPH_LOOKUPS },
    query: { type: "string", description: "What you asked it.", pattern: NOT_BLANK },
    detail: { type: "string", description: "What was wrong or missing, and where the answer really was.", pattern: NOT_BLANK },
    repo: REPO,
  },
  required: ["lookup", "query", "detail"],
  additionalProperties: false,
};

export function graphMiss(store: Store, actor: Actor, input: unknown, context: OperationContext): { recorded: true } {
  const { lookup, query, detail, repo } = validateInput<{ lookup: string; query: string; detail: string; repo?: string }>("graph_miss", graphMissSchema, input);
  const db = openGraphDb(context.projectDir, resolveRepo(store, context.projectDir, repo).name);
  try {
    recordMiss(db, actor, lookup, query, detail);
  } finally {
    db.close();
  }
  return { recorded: true };
}
