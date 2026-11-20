import type { Actor, Row } from '../api.ts';
import type { Column } from '../DataTable.tsx';
import { RelativeTime } from '../ui/RelativeTime.tsx';
import { Avatar } from '../views/issues/Avatar.tsx';
import { Badge } from './Badge.tsx';

export const SHA_LENGTH = 7;

export const badge = (key: string) => (r: Row) => <Badge value={r[key]} />;
export const time = (key: string) => (r: Row) => <span className="text-fg-muted"><RelativeTime value={r[key]} /></span>;

export const ENTITY_LINK =
  'rounded-sm text-inherit hover:text-accent hover:underline focus-visible:text-accent focus-visible:underline focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color) focus-visible:outline-offset-1';

export type EntityKind = 'task' | 'issue' | 'feature';

export function hrefFor(kind: EntityKind, id: unknown): string {
  const value = String(id);
  switch (kind) {
    case 'task': return `#/tasks/${encodeURIComponent(value)}`;
    case 'issue': return `#/issues/${encodeURIComponent(value)}`;
    case 'feature': return `#/tasks?feature=${encodeURIComponent(value)}`;
  }
}

/** Who made a record, as the pages name it: the Human, or the agent's role on its host. */
export function actorText(actor: unknown): string {
  const a = actor as Actor | null | undefined;
  if (!a) return '—';
  return a.kind === 'human' ? 'Human' : `${a.role} on ${a.host}`;
}

export const authorCell = (r: Row) => {
  const name = String(r['author'] ?? '');
  return name ? (
    <span className="inline-flex items-center gap-1.5" title={actorText(r['created_by'])}>
      <Avatar author={name} size="small" />
      {name}
    </span>
  ) : (
    <span className="text-fg-muted">—</span>
  );
};

export const entityLink = (kind: EntityKind, idKey: string, labelKey: string = idKey) => (r: Row) =>
  r[idKey] === null || r[idKey] === undefined || r[idKey] === '' ? (
    <span className="text-fg-muted">—</span>
  ) : (
    <a href={hrefFor(kind, r[idKey])} className={ENTITY_LINK} onClick={(e) => e.stopPropagation()}>
      {String(r[labelKey] ?? '')}
    </a>
  );

export function Sha({ sha }: { sha: unknown }) {
  const full = sha === null || sha === undefined ? '' : String(sha);
  if (!full) return <span className="text-fg-muted">—</span>;
  return (
    <span title={full}>
      <code className="font-mono">{full.slice(0, SHA_LENGTH)}</code>
    </span>
  );
}

export const shaCell = (key: string) => (r: Row) => <span className="text-xs"><Sha sha={r[key]} /></span>;

/** A run or a check has a start and, once it is over, an end; with no end it is still running. */
export const endedBadge = (resultKey: string, done: string) => (r: Row) =>
  <Badge value={r['ended_at'] ? (r[resultKey] ?? done) : 'running'} />;

export const TASK_TITLE_COLUMN: Column = { key: 'task_title', header: 'Task', cell: entityLink('task', 'task_id', 'task_title'), truncate: true };

export const RUN_COLUMNS: Column[] = [
  { key: 'role', header: 'Role', cell: (r) => <span className="inline-flex items-center gap-1.5"><Avatar author={String(r['role'])} size="small" />{String(r['role'])}</span> },
  TASK_TITLE_COLUMN,
  { key: 'feature_name', header: 'Feature', cell: entityLink('feature', 'feature_id', 'feature_name'), truncate: true, hideBelow: 'sm' },
  { key: 'host', header: 'Host', cell: (r) => actorText(r['created_by']), hideBelow: 'md' },
  { key: 'started_at', header: 'Started', cell: time('started_at') },
  { key: 'ended_at', header: 'Ended', cell: time('ended_at'), hideBelow: 'sm' },
  { key: 'outcome', header: 'Outcome', cell: endedBadge('outcome', 'ended') },
];
