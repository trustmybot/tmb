import { Flash } from '../../ui/Flash.tsx';

export function WriteError({ error }: { error: Error | null }) {
  if (!error) return null;
  return <Flash variant="danger">{error.message}</Flash>;
}
