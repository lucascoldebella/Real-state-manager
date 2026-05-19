'use client';

import React from 'react';
import styles from './Wizard.module.css';

interface WizardProps {
  step: number;
  totalSteps: number;
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  loading?: boolean;
  children: React.ReactNode;
}

export default function Wizard({
  step,
  totalSteps,
  onBack,
  onNext,
  nextLabel = 'Próximo',
  nextDisabled = false,
  loading = false,
  children,
}: WizardProps) {
  return (
    <div className={styles.wizard}>
      <div className={styles.progress}>
        {Array.from({ length: totalSteps }).map((_, i) => (
          <div
            key={i}
            className={`${styles.dot} ${i === step ? styles.dotActive : ''} ${i < step ? styles.dotDone : ''}`}
          />
        ))}
      </div>

      <div className={styles.step}>{children}</div>

      <div className={styles.actions}>
        {onBack && step > 0 ? (
          <button type="button" className={styles.backBtn} onClick={onBack} disabled={loading}>
            ← Anterior
          </button>
        ) : <span />}
        <button
          type="button"
          className={styles.nextBtn}
          onClick={onNext}
          disabled={nextDisabled || loading}
        >
          {loading ? 'Enviando…' : nextLabel}
        </button>
      </div>
    </div>
  );
}
