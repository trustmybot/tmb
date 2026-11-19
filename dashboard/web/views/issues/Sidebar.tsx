import type { ReactNode } from 'react';
import { GitBranchIcon } from '@primer/octicons-react';
import type { Row } from '../../api.ts';
import { Badge } from '../../shared/Badge.tsx';
import { actorText, ENTITY_LINK, hrefFor } from '../../shared/columns.tsx';

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-(--borderColor-muted) py-4 text-xs first:pt-0 last:border-b-0">
      <h3 className="mb-2 flex justify-between font-semibold text-fg-muted">
        {title}
        {aside}
      </h3>
      {children}
    </section>
  );
}

const None = ({ children }: { children: ReactNode }) => <span className="text-fg-muted">{children}</span>;

export function Sidebar({ issue, tasks }: { issue: Row; tasks: Row[] }) {
  const features = [...new Map(tasks.filter((t) => t['feature_id']).map((t) => [String(t['feature_id']), String(t['feature_name'] ?? t['feature_id'])]))];
  const done = tasks.filter((t) => t['state'] === 'closed').length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  return (
    <aside aria-label="Issue details" className="min-w-0">
      <Section title="Milestone">{issue['milestone'] ? <span className="text-fg">{String(issue['milestone'])}</span> : <None>No milestone</None>}</Section>
      <Section title="Feature Branches">
        {features.length ? (
          <ul className="space-y-1">
            {features.map(([featureId, name]) => (
              <li key={featureId} className="font-mono break-all text-fg">
                <a href={hrefFor('feature', featureId)} className={`${ENTITY_LINK} flex items-start gap-1`}>
                  <GitBranchIcon size={16} className="shrink-0 text-fg-muted" aria-hidden="true" />
                  {name}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <None>No feature branch yet</None>
        )}
      </Section>
      <Section title="Tasks" aside={<span data-progress>{done} / {tasks.length}</span>}>
        <div
          role="progressbar"
          aria-label="Tasks closed"
          aria-valuemin={0}
          aria-valuemax={tasks.length}
          aria-valuenow={done}
          className="flex h-2 overflow-hidden rounded-md bg-(--bgColor-neutral-muted)"
        >
          <span className="bg-(--bgColor-success-emphasis)" style={{ width: `${pct}%` }} />
        </div>
        {tasks.length > 0 && (
          <ul className="mt-2 space-y-1.5">
            {tasks.map((t) => (
              <li key={String(t['id'])}>
                <a href={hrefFor('task', t['id'])} className={`${ENTITY_LINK} flex items-start justify-between gap-2`}>
                  <span className="min-w-0 break-words">{String(t['title'] ?? '')}</span>
                  <Badge value={t['state']} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Recorded By">
        <span className="text-fg">{actorText(issue['created_by'])}</span>
      </Section>
      <Section title="Id">
        <code className="font-mono break-all text-fg">{String(issue['id'])}</code>
      </Section>
    </aside>
  );
}
