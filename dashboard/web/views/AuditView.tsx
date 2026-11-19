import { useApi, type Row } from '../api.ts';
import { DataTable, type Column } from '../DataTable.tsx';
import { authorCell, time } from '../shared/columns.tsx';
import { Loading } from '../shared/Loading.tsx';
import { Label } from '../ui/Label.tsx';
import { Subhead } from './RunsView.tsx';

export const AUDIT_COLUMNS: Column[] = [
  { key: 'created_at', header: 'At', cell: time('created_at') },
  { key: 'author', header: 'By', cell: authorCell, hideBelow: 'sm' },
  { key: 'what', header: 'What', cell: (r) => <Label variant="secondary">{String(r['what'] ?? '—')}</Label> },
  { key: 'detail', header: 'Detail', truncate: 'fill' },
];

export function AuditView() {
  const q = useApi<Row[]>('audit?limit=300');
  return (
    <section>
      <Subhead>Audit Feed</Subhead>
      <Loading q={q}>{(rows) => <DataTable rows={rows} columns={AUDIT_COLUMNS} />}</Loading>
    </section>
  );
}
