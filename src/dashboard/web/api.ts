import { useEffect, useRef } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export type Row = Record<string, unknown>;

/** Who made a record: the Human, an agent named by its role and host, or tmb's own syncer or upgrade. */
export type Actor = { kind: 'human' } | { kind: 'agent'; role: string; host: string } | { kind: 'tmb'; source: string; remote?: string | null };

export interface Summary {
  issues: { open: number; closed: number };
  tasks_by_state: Array<{ state: string; count: number }>;
  open_features: number;
  open_runs: number;
  recent_runs: Row[];
}

export interface IssueDetail {
  issue: Row;
  discussions: Row[];
  decision_in_force: string | null;
  tasks: Row[];
  milestones: string[];
}

/** One command of a check run, as the engine records it. */
export interface CheckCommand {
  command: string;
  status: 'passed' | 'failed' | 'not_run';
  exitCode: number | null;
  startedAt: string | null;
  endedAt: string | null;
  outputTail: string;
  reason?: string;
}

export interface TaskDetail {
  task: Row;
  check_runs: Array<Row & { commands: CheckCommand[] }>;
  runs: Row[];
}

export const query = (params: Record<string, string>) => new URLSearchParams(params).toString();

const POLL_MS = 2000;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`/api/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function useApi<T>(path: string, opts: { keepPrevious?: boolean; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [path],
    queryFn: () => getJson<T>(path),
    enabled: opts.enabled ?? true,
    ...(opts.keepPrevious ? { placeholderData: keepPreviousData } : {}),
  });
}

/** The queries a data_version change refetches: everything but the poll itself and the token. */
export const liveRefreshes = (key: readonly unknown[]) => key[0] !== '__version' && key[0] !== 'token';

export function useLiveRefresh(): void {
  const client = useQueryClient();
  const seen = useRef<number | null>(null);
  const { data } = useQuery({
    queryKey: ['__version'],
    queryFn: () => getJson<{ data_version: number }>('version'),
    refetchInterval: POLL_MS,
  });
  useEffect(() => {
    if (!data) return;
    if (seen.current !== null && seen.current !== data.data_version) {
      void client.invalidateQueries({ predicate: (q) => liveRefreshes(q.queryKey) });
    }
    seen.current = data.data_version;
  }, [data, client]);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Row,
  ) {
    super(typeof body['message'] === 'string' ? body['message'] : String(body['error'] ?? `HTTP ${status}`));
  }
}

let token: Promise<string> | null = null;

/** The token a change must carry; the server hands it only to a page on its own address. */
function writeToken(): Promise<string> {
  token ??= getJson<{ token: string }>('token').then((t) => t.token, (error: unknown) => {
    token = null;
    throw error;
  });
  return token;
}

async function postJson(path: string, body: Row): Promise<Row> {
  const res = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tmb-token': await writeToken() },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Row;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export type IssueAction = 'edit' | 'comment' | 'close' | 'reopen';

export function useIssueWrite(id: string, action: IssueAction) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Row) => postJson(`issues/${id}/${action}`, body),
    onSettled: () => client.invalidateQueries({ predicate: (q) => liveRefreshes(q.queryKey) }),
  });
}
