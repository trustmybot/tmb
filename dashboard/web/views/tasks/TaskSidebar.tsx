import type { ReactNode } from 'react';
import type { TaskDetail } from '../../api.ts';
import { Badge } from '../../shared/Badge.tsx';
import { actorText, ENTITY_LINK, hrefFor, Sha } from '../../shared/columns.tsx';
import { statusText } from '../../shared/taskState.ts';
import { DescriptionList } from '../../ui/DescriptionList.tsx';
import { RelativeTime } from '../../ui/RelativeTime.tsx';

const DASH = <span className="text-fg-muted">—</span>;

const text = (v: unknown): ReactNode => (v === null || v === undefined || v === '' ? DASH : statusText(v));
const mono = (v: unknown): ReactNode => (v === null || v === undefined || v === '' ? DASH : <code className="font-mono break-all">{String(v)}</code>);

export function TaskSidebar({ task }: { task: TaskDetail['task'] }) {
  return (
    <aside aria-label="Task details" className="min-w-0 space-y-4 md:order-last">
      <DescriptionList
        items={[
          { term: 'State', detail: <Badge value={task['state']} /> },
          { term: 'Kind', detail: text(task['kind']) },
          {
            term: 'Feature',
            detail: task['feature_id'] ? (
              <a href={hrefFor('feature', task['feature_id'])} className={ENTITY_LINK}>
                {mono(task['feature_name'] ?? task['feature_id'])}
              </a>
            ) : (
              DASH
            ),
          },
          { term: 'Branch', detail: mono(task['branch']) },
          { term: 'Worktree', detail: mono(task['worktree']) },
          { term: 'Base Commit', detail: <Sha sha={task['base_commit']} /> },
          { term: 'Commit', detail: <Sha sha={task['commit_sha']} /> },
          { term: 'Review Mode', detail: text(task['review_mode']) },
          {
            term: 'Push',
            detail: task['push_result'] ? (
              <span className="space-y-1">
                <Badge value={task['push_result']} />
                {task['push_detail'] ? <span className="block break-words text-fg-muted">{String(task['push_detail'])}</span> : null}
              </span>
            ) : (
              DASH
            ),
          },
          { term: 'Recorded By', detail: actorText(task['created_by']) },
          { term: 'Created', detail: <RelativeTime value={task['created_at']} /> },
          { term: 'Updated', detail: <RelativeTime value={task['updated_at']} /> },
        ]}
      />
    </aside>
  );
}
