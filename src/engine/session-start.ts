// What a new session is told: the planner role, then the open work from the record, so the
// session resumes from the record rather than from any earlier conversation.
import plannerRole from "../../roles/planner.md" with { type: "text" };
import { openProjectStore } from "./project.ts";
import { type Store, clip } from "./store/index.ts";

export const OPEN_WORK_HEADING = "## Open work in the record";
export const OPEN_WORK_MAX = 20;

function openWork(store: Store): string {
  // Ids sort in time order, so the newest issues come last in the store's list.
  const open = store.listIssues({ state: "open" }).reverse();
  if (open.length === 0) return `${OPEN_WORK_HEADING}\n\nNo open issues.`;
  const lines = open.slice(0, OPEN_WORK_MAX).map((issue) => {
    const decision = store.newestDecision(issue.id);
    return `- ${issue.id} ${issue.title}${decision ? ` (decision: ${clip(decision.body)})` : ""}`;
  });
  if (open.length > OPEN_WORK_MAX) lines.push(`- …and ${open.length - OPEN_WORK_MAX} older open issues; issue_list shows them all.`);
  return `${OPEN_WORK_HEADING}\n\nNewest first:\n\n${lines.join("\n")}`;
}

function withRole(section: string): string {
  return `${plannerRole.trimEnd()}\n\n${section}\n`;
}

function oneLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
}

/** Never throws: a missing record gives the role alone, a bad one the role and a line naming the problem. */
export function sessionStartContext(projectDir: string): string {
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) {
    return opened.error.failure === "missing" ? plannerRole : withRole(`tmb could not read the record: ${oneLine(opened.error)}`);
  }
  try {
    return withRole(openWork(opened.store));
  } catch (error) {
    return withRole(`tmb could not read the record: ${oneLine(error)}`);
  } finally {
    opened.store.close();
  }
}

export { plannerRole };
