import { GitBranchIcon, IssueOpenedIcon } from '@primer/octicons-react';
import type { TaskDetail } from '../../api.ts';
import { statusVariant } from '../../shared/Badge.tsx';
import { taskState } from '../../shared/taskState.ts';
import { Label } from '../../ui/Label.tsx';
import { TaskSidebar } from './TaskSidebar.tsx';
import { AgentRunsSection, CheckRunsSection, SpecSection } from './sections.tsx';

export function TaskPage({ detail }: { detail: TaskDetail }) {
  const { task, check_runs, runs } = detail;
  const issueId = String(task['issue_id']);
  const StateIcon = taskState(task['state']).icon;
  return (
    <div className="space-y-6">
      <div className="space-y-2 border-b border-(--borderColor-default) pb-4">
        <h2 className="text-2xl leading-tight break-words text-fg md:text-[32px]">{String(task['title'] ?? '')}</h2>
        <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          <Label variant={statusVariant(String(task['state'] ?? ''))}>
            <StateIcon size={12} aria-hidden="true" />
            {String(task['state'] ?? '—')}
          </Label>
          {task['branch'] ? (
            <span className="inline-flex items-center gap-1 font-mono text-xs">
              <GitBranchIcon size={16} aria-hidden="true" />
              {String(task['branch'])}
            </span>
          ) : null}
          <a href={`#/issues/${encodeURIComponent(issueId)}`} className="inline-flex min-w-0 items-center gap-1 text-(--fgColor-accent) hover:underline">
            <IssueOpenedIcon size={16} aria-hidden="true" />
            <span className="break-words">{String(task['issue_title'] ?? issueId)}</span>
          </a>
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_256px]">
        <TaskSidebar task={task} />
        <div className="min-w-0 space-y-8">
          <SpecSection body={task['spec']} />
          <CheckRunsSection runs={check_runs} />
          <AgentRunsSection runs={runs} />
        </div>
      </div>
    </div>
  );
}
