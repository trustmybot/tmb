import type { Row } from '../../api.ts';

/** When it was opened: the remote's own time for a mirrored row, the record's for a local one. */
export const openedAt = (row: Row): unknown => row['remote_created_at'] ?? row['created_at'];

/** `owner/name#12` from a mirrored issue's address, or the address itself when it is not one. */
export function remoteName(url: string): string {
  const found = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)$/.exec(url);
  return found ? `${found[1]}#${found[2]}` : url;
}

/** Says plainly that the issue is mirrored from the remote, and links to it there. Nothing for a local one. */
export function MirroredFrom({ row }: { row: Row }) {
  const url = row['remote_url'];
  if (typeof url !== 'string' || url === '') return null;
  return (
    <span data-mirrored>
      mirrored from{' '}
      <a href={url} target="_blank" rel="noreferrer noopener" className="text-(--fgColor-accent) hover:underline">
        {remoteName(url)}
      </a>
    </span>
  );
}
