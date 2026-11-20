import { Label, LABEL_COLORS, type LabelVariant } from '../ui/Label.tsx';

export const STATUS_VARIANT: Record<string, LabelVariant> = {
  open: 'accent',
  running: 'attention',
  closed: 'secondary',
  passed: 'success',
  pushed: 'success',
  allow: 'success',
  failed: 'danger',
  deny: 'danger',
  not_run: 'severe',
  skipped: 'secondary',
  stopped: 'secondary',
  finished: 'success',
  pr_open: 'attention',
  merged: 'done',
  decision: 'done',
  note: 'secondary',
};

export const statusVariant = (status: string): LabelVariant => STATUS_VARIANT[status] ?? 'default';

export const STATUS_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_VARIANT).map(([status, variant]) => [status, `border ${LABEL_COLORS[variant]}`]),
);

export function Badge({ value }: { value: unknown }) {
  const s = String(value ?? '—');
  return <Label variant={statusVariant(s)}>{s}</Label>;
}
