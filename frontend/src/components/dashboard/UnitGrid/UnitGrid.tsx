import React from 'react';
import { Badge } from '../../ui/Badge/Badge';
import type { DashboardGridItem } from '../../../lib/types';
import styles from './UnitGrid.module.css';

interface UnitGridProps {
  items: DashboardGridItem[];
  title?: string;
  subtitle?: string;
  onUnitClick?: (unit: DashboardGridItem) => void;
  hideDisabled?: boolean;
}

export const UnitGrid: React.FC<UnitGridProps> = ({ items, title, subtitle, onUnitClick, hideDisabled = false }) => {
  const visibleItems = hideDisabled ? items.filter((item) => item.status !== 'disabled') : items;

  const getStatusConfig = (status: DashboardGridItem['status']) => {
    switch (status) {
      case 'paid': return { variant: 'success' as const, label: 'Paid' };
      case 'overdue': return { variant: 'danger' as const, label: 'Overdue' };
      case 'due_soon': return { variant: 'warning' as const, label: 'Due soon' };
      case 'vacant': return { variant: 'neutral' as const, label: 'Vacant' };
      case 'disabled': return { variant: 'neutral' as const, label: 'Disabled' };
      default: return { variant: 'warning' as const, label: 'Unpaid' };
    }
  };

  return (
    <div className={styles.gridContainer}>
      <div className={styles.header}>
        <div>
          <h3 className={styles.title}>{title || 'Property Control Center'}</h3>
          <p className={styles.subtitle}>{subtitle || 'Real-time status of all units'}</p>
        </div>
        <div className={styles.legend}>
          <div className={styles.legendItem}><span className={`${styles.dot} ${styles.dotSuccess}`}></span>Paid</div>
          <div className={styles.legendItem}><span className={`${styles.dot} ${styles.dotDanger}`}></span>Overdue</div>
          <div className={styles.legendItem}><span className={`${styles.dot} ${styles.dotWarning}`}></span>Due soon</div>
          <div className={styles.legendItem}><span className={`${styles.dot} ${styles.dotNeutral}`}></span>Vacant</div>
          {!hideDisabled && <div className={styles.legendItem}><span className={`${styles.dot} ${styles.dotDisabled}`}></span>Disabled</div>}
        </div>
      </div>
      
      <div className={styles.grid}>
        {visibleItems.map((unit) => {
          const config = getStatusConfig(unit.status);
          return (
            <div
              key={unit.id}
              className={`${styles.unitCard} ${styles[`status-${unit.status}`]}`}
              onClick={() => onUnitClick?.(unit)}
            >
              <div className={styles.unitHeader}>
                <span className={styles.unitNumber}>{unit.unit_number}</span>
                <Badge variant={config.variant}>{config.label}</Badge>
              </div>
              <div className={styles.tenantInfo}>
                {unit.status === 'disabled' ? (
                  <span className={styles.vacantText}>
                    {unit.inactive_reason || 'Unavailable'}
                    {unit.available_from ? ` • Ready ${unit.available_from}` : ''}
                  </span>
                ) : unit.tenant_name ? (
                  <span className={styles.tenantName}>{unit.tenant_name}</span>
                ) : (
                  <span className={styles.vacantText}>Available for rent</span>
                )}
              </div>
              <div className={styles.cardGlow}></div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
