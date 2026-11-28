import { CheckIcon, CommentIcon, IssueClosedIcon, IssueOpenedIcon, TasklistIcon } from '@primer/octicons-react';
import type { Row } from '../../api.ts';
import { EntityList, type ListChip, type ListSort, type ListTab } from '../../shared/list/EntityList.tsx';
import { ListRow } from '../../shared/list/ListRow.tsx';
import { RelativeTime } from '../../ui/RelativeTime.tsx';
import { MilestoneMenu } from './MilestoneMenu.tsx';
import { hasMilestone, milestoneLabel } from './milestones.ts';
import { openedAt } from './remote.tsx';

export type IssueState = 'open' | 'closed';

const SORTS: Record<string, ListSort> = {
  updated: { label: 'Recently Updated', key: 'updated_at', dir: -1 },
  newest: { label: 'Newest', key: 'opened_at', dir: -1 },
  oldest: { label: 'Oldest', key: 'opened_at', dir: 1 },
};

const TABS: ListTab[] = [
  { key: 'open', label: 'Open', icon: IssueOpenedIcon, filter: (r) => r['state'] === 'open' },
  { key: 'closed', label: 'Closed', icon: CheckIcon, filter: (r) => r['state'] !== 'open' },
];

const matches = (issue: Row, needle: string) =>
  !needle || `${String(issue['id'])} ${String(issue['title'] ?? '')} ${String(issue['milestone'] ?? '')}`.toLowerCase().includes(needle);

function IssueRow({ issue }: { issue: Row }) {
  const open = issue['state'] === 'open';
  const StateIcon = open ? IssueOpenedIcon : IssueClosedIcon;
  const taskCount = Number(issue['task_count'] ?? 0);
  return (
    <ListRow
      icon={<StateIcon size={16} className={open ? 'text-(--fgColor-open)' : 'text-(--fgColor-done)'} aria-label={open ? 'Open issue' : 'Closed issue'} />}
      href={`#/issues/${String(issue['id'])}`}
      title={String(issue['title'] ?? '')}
      meta={
        <span>
          {issue['milestone'] ? `${String(issue['milestone'])} · ` : ''}
          {open ? 'opened' : 'closed'} <RelativeTime value={open ? openedAt(issue) : issue['updated_at']} /> by {String(issue['author'] ?? '—')}
          {issue['remote_url'] ? ' · mirrored' : ''}
        </span>
      }
      aside={
        <>
          {taskCount > 0 && (
            <span className="hidden items-center gap-1 sm:flex" title="Tasks closed">
              <TasklistIcon size={16} aria-hidden="true" />
              {String(issue['tasks_done'] ?? 0)}/{taskCount}
            </span>
          )}
          <span className="flex items-center gap-1" title="Notes and decisions">
            <CommentIcon size={16} aria-hidden="true" />
            {String(issue['discussion_count'] ?? 0)}
          </span>
        </>
      }
    />
  );
}

export function IssueList({ rows, state, milestone = null }: { rows: Row[]; state: IssueState; milestone?: string | null }) {
  const shown = rows.filter((r) => !milestone || hasMilestone(r, milestone));
  const chips: ListChip[] = milestone ? [{ key: 'milestone', label: milestoneLabel(milestone), clearLabel: 'Remove milestone filter' }] : [];
  return (
    <EntityList
      rows={shown}
      tabs={TABS}
      sorts={SORTS}
      matches={matches}
      renderRow={(r) => <IssueRow issue={r} />}
      chips={chips}
      tab={state}
      path="issues"
      noun={['issue', 'issues', 'Issues']}
      emptyIcon={IssueOpenedIcon}
      searchPlaceholder="Search by title, milestone or id"
      controls={<MilestoneMenu rows={rows} value={milestone} />}
    />
  );
}
