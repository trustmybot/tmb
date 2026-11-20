export type HelpKey = 'overview' | 'issues' | 'tasks' | 'runs' | 'audit' | 'code' | 'issue' | 'task';

export interface HelpEntry {
  intro: string;
  layers?: { name: string; text: string }[];
  uses: string[];
}

export const HELP_USES_HEADING = 'Use It To';

export const HELP: Record<HelpKey, HelpEntry> = {
  overview: {
    intro: "A snapshot of this project's record: open issues, tasks by state, open feature branches and recent agent runs. It reads the project's .tmb/trajectory.db.",
    uses: ['Check what is open before you start a session.', 'See which agents are running now.'],
  },
  issues: {
    intro: 'Every issue in the record, with its milestone and how many of its tasks are closed. The planner opens issues from your requests; you can edit them here.',
    uses: ['Find an issue by title or milestone.', 'Check which issues still have open tasks.', 'Open an issue to read its notes and decisions.'],
  },
  issue: {
    intro: "One issue's history: its notes, its decisions and the tasks it was split into. The latest decision is the one in force.",
    uses: ['Read why a decision was made.', 'Record a note or a decision for the planner to read.', 'Edit the title, body or milestone, or close the issue.'],
  },
  tasks: {
    intro: 'All tasks across issues, each a unit of work a worker picks up in its own worktree. A task closes once its checks pass and its branch is folded in.',
    uses: ['Find open tasks on a feature branch.', 'Check the last check run of each task.', 'Compare progress across issues.'],
  },
  task: {
    intro: "One task's spec, its check runs with each command's output, and the agent runs that worked on it.",
    uses: ['Check that the work matches the spec.', 'Read why a check failed.', 'Find the branch, worktree or commit for this task.'],
  },
  runs: {
    intro: 'Each agent run, each check run, and each decision the guard made on a tool call. Rows are recorded as runs start and end and as the guard decides.',
    uses: ['Find check runs that failed and see why.', 'Find when and why a tool call was denied.', 'See which agents are still running.'],
  },
  audit: {
    intro: 'A time-ordered log of what the engine recorded beyond the projections, newest first. Nothing here can be edited.',
    uses: ['Trace what happened, step by step.', 'Check what an agent did while you were away.'],
  },
  code: {
    intro: "The project's code as a graph, read from .tmb/graph.db at the base branch: folders, then a folder's files, then a file's classes and functions, one level at a time. Every function is there, the unnamed ones too, named by where they are used. Links are calls and imports the graph could prove; calls it could not prove are counted on each function.",
    uses: ['See how the parts of the project call each other.', 'Find a function by name and see who calls it and what it calls.', 'Find the files the graph could not parse.'],
  },
};

export const DETAIL_PAGE: Record<'issue' | 'task', string> = { issue: 'Issue Detail', task: 'Task Detail' };

export function helpKey(tab: string, id: string | undefined): HelpKey {
  if (id && tab === 'issues') return 'issue';
  if (id && tab === 'tasks') return 'task';
  return tab in HELP && !(tab in DETAIL_PAGE) ? (tab as HelpKey) : 'overview';
}
