import { useApi, type Row, type Summary } from '../api.ts';
import { Loading } from '../shared/Loading.tsx';
import { Overview } from './overview/Overview.tsx';

export function OverviewView() {
  const summary = useApi<Summary>('summary');
  const issues = useApi<Row[]>('issues');
  return (
    <div className="min-w-0 space-y-6">
      <Loading q={summary}>{(s) => <Overview summary={s} issues={{ data: issues.data, error: issues.error }} />}</Loading>
    </div>
  );
}
