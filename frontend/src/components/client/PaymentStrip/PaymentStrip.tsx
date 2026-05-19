'use client';

import React from 'react';
import type { PaymentStripItem } from '../../../lib/types';
import styles from './PaymentStrip.module.css';

const MONTH_LABELS = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

function getMonthLabel(month: string): string {
  const parts = month.split('-');
  if (parts.length === 2) {
    const idx = parseInt(parts[1], 10) - 1;
    if (idx >= 0 && idx < 12) return MONTH_LABELS[idx];
  }
  return month.slice(-2);
}

function getCardClass(status: string): string {
  if (status === 'paid') return styles.cardPaid;
  if (status === 'overdue') return styles.cardOverdue;
  if (status === 'due_soon') return styles.cardDueSoon;
  return styles.cardUnpaid;
}

function formatAmount(amount: number): string {
  if (amount >= 1000) return `R$${(amount / 1000).toFixed(1)}k`;
  return `R$${amount.toFixed(0)}`;
}

export default function PaymentStrip({
  items,
  onSelect,
}: {
  items: PaymentStripItem[];
  onSelect?: (item: PaymentStripItem) => void;
}) {
  const sorted = [...items].sort((a, b) => a.month.localeCompare(b.month));

  return (
    <div className={styles.strip}>
      {sorted.map((item) => (
        <button
          key={item.month}
          type="button"
          className={`${styles.card} ${getCardClass(item.status)}`}
          onClick={() => onSelect?.(item)}
          title={`${item.month} — ${item.status}`}
        >
          <span className={styles.month}>{getMonthLabel(item.month)}</span>
          <span className={styles.amount}>{formatAmount(item.amount)}</span>
        </button>
      ))}
    </div>
  );
}
