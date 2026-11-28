import type { ReactNode } from 'react';
import { useApi, type Row } from '../api.ts';
import { DataTable, type Column } from '../DataTable.tsx';
import { authorCell, badge, endedBadge, RUN_COLUMNS, shaCell, TASK_TITLE_COLUMN, time } from '../shared/columns.tsx';
import { Loading } from '../shared/Loading.tsx';

export const CHECK_RUN_COLUMNS: Column[] = [
  TASK_TITLE_COLUMN,
  { key: 'commit_sha', header: 'Commit', cell: shaCell('commit_sha'), hideBelow: 'sm' },
  { key: 'result', header: 'Result', cell: endedBadge('result', 'ended') },
  {
    key: 'failed',
    header: 'Failed',
    cell: (r) => {
      const commands = Array.isArray(r['commands']) ? (r['commands'] as Row[]) : [];
      return `${commands.filter((c) => c['status'] === 'failed').length}/${commands.length}`;
    },
    hideBelow: 'sm',
  },
  { key: 'started_at', header: 'Started', cell: time('started_at') },
];

export const GUARD_DECISION_COLUMNS: Column[] = [
  { key: 'created_at', header: 'At', cell: time('created_at') },
  { key: 'author', header: 'Agent', cell: authorCell, hideBelow: 'sm' },
  { key: 'event', header: 'Event', truncate: true },
  { key: 'decision', header: 'Decision', cell: badge('decision') },
  { key: 'reason', header: 'Reason', truncate: 'fill' },
];

export function Subhead({ children }: { children: ReactNode }) {
  return <h2 className="mb-4 border-b border-(--borderColor-muted) pb-2 text-base font-semibold text-fg">{children}</h2>;
}

export function RunsView() {
  const runs = useApi<Row[]>('runs?limit=300');
  const checks = useApi<Row[]>('checks?limit=300');
  const guards = useApi<Row[]>('guard-decisions?limit=300');
  return (
    <div className="space-y-8">
      <section>
        <Subhead>Agent Runs</Subhead>
        <Loading q={runs}>{(rows) => <DataTable rows={rows} columns={RUN_COLUMNS} />}</Loading>
      </section>
      <section>
        <Subhead>Check Runs</Subhead>
        <Loading q={checks}>{(rows) => <DataTable rows={rows} columns={CHECK_RUN_COLUMNS} />}</Loading>
      </section>
      <section>
        <Subhead>Gate Decisions</Subhead>
        <Loading q={guards}>{(rows) => <DataTable rows={rows} columns={GUARD_DECISION_COLUMNS} />}</Loading>
      </section>
    </div>
  );
}
