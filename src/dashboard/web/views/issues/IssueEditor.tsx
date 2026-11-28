import { useState } from 'react';
import { useIssueWrite, type IssueDetail, type Row } from '../../api.ts';
import { FIELD } from '../../shared/classes.ts';
import { Button } from '../../ui/Button.tsx';
import { Flash } from '../../ui/Flash.tsx';
import { WriteError } from './WriteError.tsx';

export function IssueEditor({ id, detail, onDone }: { id: string; detail: IssueDetail; onDone: () => void }) {
  const [base] = useState(() => detail.issue);
  const changedElsewhere = detail.issue['updated_at'] !== base['updated_at'];
  const title0 = String(base['title'] ?? '');
  const body0 = String(base['body'] ?? '');
  const milestone0 = String(base['milestone'] ?? '');
  const [title, setTitle] = useState(title0);
  const [body, setBody] = useState(body0);
  const [milestone, setMilestone] = useState(milestone0);
  const write = useIssueWrite(id, 'edit');

  const save = () => {
    const change: Row = { updated_at: base['updated_at'] };
    if (title !== title0) change['title'] = title;
    if (body !== body0) change['body'] = body;
    if (milestone !== milestone0) change['milestone'] = milestone;
    if (Object.keys(change).length === 1) return onDone();
    write.mutate(change, { onSuccess: onDone });
  };

  return (
    <form
      className="space-y-3 border-b border-(--borderColor-default) pb-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {changedElsewhere && (
        <div role="status">
          <Flash variant="warning">This issue changed since you started editing. Cancel and reopen the editor to see it; saving now is refused as stale.</Flash>
        </div>
      )}
      <label className="block space-y-1 text-sm font-semibold">
        <span>Title</span>
        <input className={FIELD} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="block space-y-1 text-sm font-semibold">
        <span>Body</span>
        <textarea className={`${FIELD} h-40 font-mono`} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <label className="block space-y-1 text-sm font-semibold md:w-1/3">
        <span>Milestone</span>
        <input className={FIELD} list="tmb-milestones" value={milestone} onChange={(e) => setMilestone(e.target.value)} />
        <datalist id="tmb-milestones">
          {detail.milestones.map((m) => <option key={m} value={m} />)}
        </datalist>
      </label>
      <WriteError error={write.error} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="small" disabled={write.isPending}>Save</Button>
        <Button size="small" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
