// What a new session is told: the planner role, then the open work from the record, so the
// session resumes from the record rather than from any earlier conversation, then the project's
// layout from the code graph as it was last indexed.
import { existsSync } from "node:fs";
import plannerRole from "../../roles/planner.md" with { type: "text" };
import { BASE_LAYER, graphDbPath, layerRow, openGraphDb } from "./graph/db.ts";
import { projectMap } from "./graph/lookups.ts";
import { UNTRUSTED_NOTE } from "./graph/summary.ts";
import { openProjectStore } from "./project.ts";
import { type Store, clip } from "./store/index.ts";

export const OPEN_WORK_HEADING = "## Open work in the record";
export const OPEN_WORK_MAX = 20;
export const PROJECT_MAP_HEADING = "## The project, from the code graph";
export const PROJECT_MAP_MAX_DIRS = 40;
const MAP_SUMMARY_MAX = 120;

function openWork(store: Store): string {
  return `${OPEN_WORK_HEADING}\n\n${openIssues(store)}${openTasks(store)}`;
}

function openIssues(store: Store): string {
  // Ids sort in time order, so the newest issues come last in the store's list.
  const open = store.listIssues({ state: "open" }).reverse();
  if (open.length === 0) return "No open issues.";
  const lines = open.slice(0, OPEN_WORK_MAX).map((issue) => {
    const decision = store.newestDecision(issue.id);
    return `- ${issue.id} ${issue.title}${decision ? ` (decision: ${clip(decision.body)})` : ""}`;
  });
  if (open.length > OPEN_WORK_MAX) lines.push(`- …and ${open.length - OPEN_WORK_MAX} older open issues; issue_list shows them all.`);
  return `Newest first:\n\n${lines.join("\n")}`;
}

/** The open tasks, oldest first, so a session resumes a task a worker left open; empty when none is. */
function openTasks(store: Store): string {
  const open = store.listTasks("open");
  if (open.length === 0) return "";
  const lines = open.slice(0, OPEN_WORK_MAX).map((task) => {
    const feature = task.featureId === null ? null : store.getFeature(task.featureId)?.name;
    return `- ${task.id} ${task.title} (issue ${task.issueId}${feature ? `, feature branch ${feature}` : ""}, worktree ${task.worktree ?? "none"})`;
  });
  if (open.length > OPEN_WORK_MAX) lines.push(`- …and ${open.length - OPEN_WORK_MAX} newer open tasks; task_list shows them all.`);
  return `\n\nOpen tasks, oldest first:\n\n${lines.join("\n")}`;
}

const shorten = (text: string): string => (text.length <= MAP_SUMMARY_MAX ? text : `${text.slice(0, MAP_SUMMARY_MAX - 1)}…`);

/**
 * The base branch's directories as the graph last indexed them, without bringing it forward:
 * session start must stay fast, and graph_map answers from the newest commit. Empty when the
 * project has no graph yet or it cannot be read.
 */
function projectMapSection(projectDir: string): string {
  if (!existsSync(graphDbPath(projectDir))) return "";
  try {
    const db = openGraphDb(projectDir);
    try {
      const layer = layerRow(db, BASE_LAYER);
      if (layer === null) return "";
      const { dirs } = projectMap(db, BASE_LAYER, { depth: 3 });
      const lines = dirs.slice(0, PROJECT_MAP_MAX_DIRS).map((dir) => {
        const summary = dir.summary ? `: ${shorten(dir.summary.replace(/\s+/g, " "))}` : "";
        return `- ${dir.path === "." ? "./" : `${dir.path}/`} (${dir.fileCount} files)${summary}`;
      });
      if (dirs.length > PROJECT_MAP_MAX_DIRS) lines.push(`- …and ${dirs.length - PROJECT_MAP_MAX_DIRS} more; graph_map shows them.`);
      return (
        `\n\n${PROJECT_MAP_HEADING}\n\nAs indexed at ${layer.commit_sha.slice(0, 12)}: ${layer.files} files, ${layer.symbols} symbols. ` +
        `Scope from here with graph_map, graph_find, graph_symbol and graph_scope, which bring the graph to the newest commit first. ${UNTRUSTED_NOTE}\n\n${lines.join("\n")}`
      );
    } finally {
      db.close();
    }
  } catch {
    return "";
  }
}

function withRole(section: string): string {
  return `${plannerRole.trimEnd()}\n\n${section}\n`;
}

function oneLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
}

export const UNATTENDED_INSTRUCTION =
  "## Unattended run\n\nNo one can answer in this run, so apply your defaults, name each default you used, and stop with the reason when a default is not safe.";

/**
 * The role and the open work, then, when `unattended` says no one can answer in this run,
 * the instruction for it. Nothing about the mode is stored in the project.
 */
export function sessionStartContext(projectDir: string, unattended: boolean): string {
  const context = attendedContext(projectDir);
  return unattended ? `${context.trimEnd()}\n\n${UNATTENDED_INSTRUCTION}\n` : context;
}

/** Never throws: a missing record gives the role alone, a bad one the role and a line naming the problem. */
function attendedContext(projectDir: string): string {
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) {
    return opened.error.failure === "missing" ? plannerRole : withRole(`tmb could not read the record: ${oneLine(opened.error)}`);
  }
  try {
    return withRole(`${openWork(opened.store)}${projectMapSection(projectDir)}`);
  } catch (error) {
    return withRole(`tmb could not read the record: ${oneLine(error)}`);
  } finally {
    opened.store.close();
  }
}

export { plannerRole };
