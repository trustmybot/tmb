import { CheckIcon, GitBranchIcon, IssueOpenedIcon, TasklistIcon } from '@primer/octicons-react';
import { useApi, type Row } from '../api.ts';
import { Badge } from '../shared/Badge.tsx';
import { FIELD } from '../shared/classes.ts';
import { ENTITY_LINK, hrefFor } from '../shared/columns.tsx';
import { EntityList, type ListChip, type ListSort, type ListTab } from '../shared/list/EntityList.tsx';
import { ListRow } from '../shared/list/ListRow.tsx';
import { useListParams } from '../shared/list/useListParams.ts';
import { Loading } from '../shared/Loading.tsx';
import { hrefWith } from '../shared/route.ts';
import { statusText, taskState } from '../shared/taskState.ts';
import { RelativeTime } from '../ui/RelativeTime.tsx';

const SORTS: Record<string, ListSort> = {
  updated: { label: 'Recently Updated', key: 'updated_at', dir: -1 },
  newest: { label: 'Newest', key: 'created_at', dir: -1 },
  oldest: { label: 'Oldest', key: 'created_at', dir: 1 },
};

const TABS: ListTab[] = [
  { key: 'open', label: 'Open', icon: TasklistIcon, filter: (r) => r['state'] !== 'closed' },
  { key: 'closed', label: 'Closed', icon: CheckIcon, filter: (r) => r['state'] === 'closed' },
];

const matches = (task: Row, needle: string) =>
  !needle ||
  `${String(task['id'])} ${String(task['title'] ?? '')} ${String(task['branch'] ?? '')} ${String(task['feature_name'] ?? '')} ${String(task['issue_title'] ?? '')}`
    .toLowerCase()
    .includes(needle);

const Sep = () => <span aria-hidden="true">·</span>;

export function TaskRow({ task }: { task: Row }) {
  const { icon: StateIcon, className } = taskState(task['state']);
  const id = String(task['id']);
  const branch = task['branch'] ? String(task['branch']) : '';
  return (
    <ListRow
      icon={<StateIcon size={16} className={className} aria-hidden="true" />}
      href={hrefFor('task', id)}
      title={String(task['title'] || `Task ${id}`)}
      meta={
        <>
          <span>
            {statusText(task['kind'])} task {statusText(task['state'])}
          </span>
          {branch && (
            <>
              <Sep />
              <span title={branch} className="inline-flex min-w-0 max-w-full items-center gap-1">
                <GitBranchIcon size={12} aria-hidden="true" />
                <span className="max-w-60 truncate font-mono">{branch}</span>
              </span>
            </>
          )}
          <Sep />
          <a href={hrefFor('issue', task['issue_id'])} className={`${ENTITY_LINK} inline-flex min-w-0 max-w-full items-center gap-1`}>
            <IssueOpenedIcon size={12} aria-hidden="true" />
            <span className="truncate">{String(task['issue_title'] ?? task['issue_id'])}</span>
          </a>
          <Sep />
          <span>
            updated <RelativeTime value={task['updated_at']} />
          </span>
        </>
      }
      aside={
        <>
          {task['feature_name'] ? (
            <a href={hrefFor('feature', task['feature_id'])} className={`${ENTITY_LINK} hidden font-mono sm:inline`}>{String(task['feature_name'])}</a>
          ) : null}
          {task['last_check'] ? (
            <span title="Last check run">
              <Badge value={task['last_check']} />
            </span>
          ) : null}
        </>
      }
    />
  );
}

function KindSelect({ value, kinds }: { value: string; kinds: string[] }) {
  return (
    <label className="flex shrink-0 items-center gap-2 text-sm text-fg-muted">
      Kind
      <select
        className={`${FIELD} w-auto py-1.5`}
        value={value}
        onChange={(e) => {
          window.location.hash = hrefWith({ kind: e.target.value || null }, 'tasks');
        }}
      >
        <option value="">All</option>
        {kinds.map((k) => (
          <option key={k} value={k}>{statusText(k)}</option>
        ))}
      </select>
    </label>
  );
}

export function TaskList({ rows, params }: { rows: Row[]; params: URLSearchParams }) {
  const kind = params.get('kind') ?? '';
  const feature = params.get('feature') ?? '';
  const issue = params.get('issue') ?? '';
  const filtered = rows.filter(
    (r) =>
      (!kind || r['kind'] === kind) &&
      (!feature || String(r['feature_id'] ?? '') === feature) &&
      (!issue || String(r['issue_id'] ?? '') === issue),
  );
  const kinds = [...new Set(rows.map((r) => String(r['kind'] ?? '')).filter(Boolean))].sort();
  const featureName = rows.find((r) => String(r['feature_id'] ?? '') === feature)?.['feature_name'];
  const issueTitle = rows.find((r) => String(r['issue_id'] ?? '') === issue)?.['issue_title'];
  const chips: ListChip[] = [];
  if (feature) chips.push({ key: 'feature', label: `Feature: ${String(featureName ?? feature)}`, clearLabel: 'Remove feature filter' });
  if (issue) chips.push({ key: 'issue', label: `Issue: ${String(issueTitle ?? issue)}`, clearLabel: 'Remove issue filter' });
  return (
    <EntityList
      rows={filtered}
      tabs={TABS}
      sorts={SORTS}
      matches={matches}
      renderRow={(r) => <TaskRow task={r} />}
      chips={chips}
      tab={params.get('state') === 'closed' ? 'closed' : 'open'}
      path="tasks"
      noun={['task', 'tasks', 'Tasks']}
      emptyIcon={TasklistIcon}
      searchPlaceholder="Search by title, branch, feature or issue"
      controls={<KindSelect value={kind} kinds={kinds} />}
    />
  );
}

export function TasksView() {
  const q = useApi<Row[]>('tasks');
  const params = useListParams();
  return <Loading q={q}>{(rows) => <TaskList rows={rows} params={params} />}</Loading>;
}
