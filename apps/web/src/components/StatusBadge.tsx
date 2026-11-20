import type { ReactNode } from 'react';

export type BadgeTone = 'success' | 'warning' | 'danger' | 'neutral' | 'sponsored';

interface StatusBadgeProps {
  tone: BadgeTone;
  icon: string;
  label: ReactNode;
}

const TONE_CLASSES: Record<BadgeTone, string> = {
  success: 'bg-success-bg text-brand border border-brand/20',
  warning: 'bg-warning text-warning-ink border border-ink/15',
  danger: 'bg-danger-bg text-danger border border-danger/25',
  neutral: 'bg-canvas-muted text-ink-soft border border-ink/10',
  sponsored: 'bg-sponsored-bg text-ink border border-sponsored'
};

export function StatusBadge({ tone, icon, label }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ${TONE_CLASSES[tone]}`}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </span>
  );
}
