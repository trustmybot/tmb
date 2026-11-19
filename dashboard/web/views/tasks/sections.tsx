import type { ReactNode } from 'react';
import type { CheckCommand, TaskDetail } from '../../api.ts';
import { DataTable } from '../../DataTable.tsx';
import { Markdown } from '../../Markdown.tsx';
import { Badge } from '../../shared/Badge.tsx';
import { RUN_COLUMNS, Sha } from '../../shared/columns.tsx';
import { CodeBlock } from '../../ui/CodeBlock.tsx';
import { Disclosure } from '../../ui/Disclosure.tsx';
import { RelativeTime } from '../../ui/RelativeTime.tsx';
import { Muted, Section } from './Section.tsx';

const OUTPUT_LINES = 20;

const InlineCode = ({ children }: { children: ReactNode }) => (
  <code className="rounded-md bg-(--bgColor-muted) px-[.4em] py-[.2em] font-mono text-xs break-all">{children}</code>
);

const Meta = ({ children }: { children: ReactNode }) => <span className="text-xs text-fg-muted">{children}</span>;

export function SpecSection({ body }: { body: unknown }) {
  const text = typeof body === 'string' ? body.trim() : '';
  return <Section title="Spec">{text ? <Markdown>{text}</Markdown> : <Muted>No spec written.</Muted>}</Section>;
}

function seconds(c: CheckCommand): string | null {
  if (!c.startedAt || !c.endedAt) return null;
  return `${((Date.parse(c.endedAt) - Date.parse(c.startedAt)) / 1000).toFixed(1)}s`;
}

function Command({ c, n }: { c: CheckCommand; n: number }) {
  const elapsed = seconds(c);
  return (
    <li className="space-y-1.5 text-sm" data-check-command>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-fg-muted">{n}.</span>
        <InlineCode>{c.command}</InlineCode>
        <Badge value={c.status} />
        {c.exitCode !== null && c.exitCode !== undefined && <Meta>exit {c.exitCode}</Meta>}
        {elapsed && <Meta>{elapsed}</Meta>}
      </div>
      {c.reason ? <p className="text-xs text-fg-muted">{c.reason}</p> : null}
      {c.outputTail ? <CodeBlock text={c.outputTail} label={`Output of command ${n}`} maxLines={OUTPUT_LINES} /> : c.status === 'not_run' ? null : <Muted>No output captured.</Muted>}
    </li>
  );
}

export function CheckRunsSection({ runs }: { runs: TaskDetail['check_runs'] }) {
  return (
    <Section title="Check Runs">
      {runs.length ? (
        <div className="space-y-2">
          {runs.map((r, i) => (
            <Disclosure
              key={String(r['id'])}
              defaultOpen={i === 0}
              summary={
                <>
                  <Badge value={r['ended_at'] ? r['result'] : 'running'} />
                  <span className="text-xs">
                    <Sha sha={r['commit_sha']} />
                  </span>
                  <Meta>
                    {r.commands.length} {r.commands.length === 1 ? 'command' : 'commands'} · <RelativeTime value={r['started_at']} />
                  </Meta>
                </>
              }
            >
              {r.commands.length ? (
                <ol className="space-y-3">
                  {r.commands.map((c, n) => (
                    <Command key={n} c={c} n={n + 1} />
                  ))}
                </ol>
              ) : (
                <Muted>No commands recorded for this run.</Muted>
              )}
            </Disclosure>
          ))}
        </div>
      ) : (
        <Muted>No check runs yet.</Muted>
      )}
    </Section>
  );
}

const TASK_RUN_COLUMNS = RUN_COLUMNS.filter((c) => c.key !== 'task_title');

export function AgentRunsSection({ runs }: { runs: TaskDetail['runs'] }) {
  return (
    <Section title="Agent Runs">
      {runs.length ? <DataTable rows={runs} columns={TASK_RUN_COLUMNS} filter={false} /> : <Muted>No agent runs recorded.</Muted>}
    </Section>
  );
}
