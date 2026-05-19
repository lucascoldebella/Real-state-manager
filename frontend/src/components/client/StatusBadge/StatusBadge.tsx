import React from 'react';
import type { TicketStatus, ComplaintStatus } from '../../../lib/types';

const MAP: Record<string, { label: string; color: string; bg: string }> = {
  open:        { label: 'Aberto',       color: 'var(--info-text)',    bg: 'var(--info-bg)' },
  in_progress: { label: 'Em andamento', color: 'var(--warning-text)', bg: 'var(--warning-bg)' },
  resolved:    { label: 'Resolvido',    color: 'var(--success-text)', bg: 'var(--success-bg)' },
  closed:      { label: 'Encerrado',    color: 'var(--neutral-text)', bg: 'var(--neutral-bg)' },
  new:         { label: 'Nova',         color: 'var(--info-text)',    bg: 'var(--info-bg)' },
  reviewed:    { label: 'Analisada',    color: 'var(--success-text)', bg: 'var(--success-bg)' },
  archived:    { label: 'Arquivada',    color: 'var(--neutral-text)', bg: 'var(--neutral-bg)' },
};

export default function StatusBadge({ status }: { status: TicketStatus | ComplaintStatus | string }) {
  const cfg = MAP[status] ?? { label: status, color: 'var(--text-muted)', bg: 'var(--neutral-bg)' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 10px', borderRadius: 'var(--radius-full)',
      fontSize: '11px', fontWeight: 600,
      color: cfg.color, background: cfg.bg,
    }}>
      {cfg.label}
    </span>
  );
}
