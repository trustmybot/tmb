import { useState } from 'react';
import type { IssueDetail } from '../../api.ts';
import { Button } from '../../ui/Button.tsx';
import { Label } from '../../ui/Label.tsx';
import { RelativeTime } from '../../ui/RelativeTime.tsx';
import { StateLabel } from '../../ui/StateLabel.tsx';
import { Composer } from './Composer.tsx';
import { IssueEditor } from './IssueEditor.tsx';
import { MirroredFrom, openedAt } from './remote.tsx';
import { Sidebar } from './Sidebar.tsx';
import { CommentCard, Timeline } from './Timeline.tsx';

export function IssuePage({ id, detail }: { id: string; detail: IssueDetail }) {
  const [editing, setEditing] = useState(false);
  const { issue, discussions, tasks, decision_in_force: inForce } = detail;
  const open = issue['state'] === 'open';
  const count = discussions.length;
  return (
    <div className="space-y-6">
      {editing ? (
        <IssueEditor id={id} detail={detail} onDone={() => setEditing(false)} />
      ) : (
        <div className="space-y-2 border-b border-(--borderColor-default) pb-4">
          <h2 className="text-2xl leading-tight break-words text-fg md:text-[32px]">{String(issue['title'])}</h2>
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <StateLabel status={open ? 'open' : 'closed'} />
            <span>
              opened <RelativeTime value={openedAt(issue)} /> by {String(issue['author'] ?? '—')} · {count} {count === 1 ? 'entry' : 'entries'}
            </span>
            <MirroredFrom row={issue} />
            <Button size="small" className="ml-auto" onClick={() => setEditing(true)}>Edit</Button>
          </div>
        </div>
      )}
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_256px]">
        <div className="min-w-0">
          <CommentCard
            author={String(issue['author'] ?? '')}
            verb="opened"
            at={openedAt(issue)}
            badge={<Label variant="secondary">Author</Label>}
            body={String(issue['body'] ?? '')}
          />
          <Timeline discussions={discussions} inForce={inForce} />
          <Composer id={id} open={open} updatedAt={String(issue['updated_at'])} />
        </div>
        <Sidebar issue={issue} tasks={tasks} />
      </div>
    </div>
  );
}
