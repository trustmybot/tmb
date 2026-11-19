import { CheckCircleFillIcon, CircleIcon, DotFillIcon, type Icon } from '@primer/octicons-react';
import { LABEL_COLORS } from '../ui/Label.tsx';
import { statusVariant } from './Badge.tsx';

export const TASK_STATES = ['open', 'closed'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_STATE_ICON: Record<TaskState, Icon> = {
  open: DotFillIcon,
  closed: CheckCircleFillIcon,
};

const textClass = (classes: string) => classes.split(' ').find((c) => c.startsWith('text-')) ?? 'text-fg';

export function taskState(state: unknown): { icon: Icon; className: string } {
  const s = String(state ?? '');
  return {
    icon: TASK_STATE_ICON[s as TaskState] ?? CircleIcon,
    className: textClass(LABEL_COLORS[statusVariant(s)]),
  };
}

export const statusText = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v).replace(/_/g, ' '));
