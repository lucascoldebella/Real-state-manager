import React from 'react';
import { Card } from '../../ui/Card/Card';
import { TrendingUp, TrendingDown, LucideIcon } from 'lucide-react';
import styles from './StatCard.module.css';

interface StatCardProps {
  title: string;
  value: string;
  icon: LucideIcon;
  subtext?: string;
  trend?: {
    value: number;
    isPositive: boolean;
  };
}

export const StatCard: React.FC<StatCardProps> = ({ title, value, icon: Icon, subtext, trend }) => {
  return (
    <Card className={styles.statCard}>
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
        <div className={styles.iconWrapper}>
          <Icon size={18} className={styles.icon} />
        </div>
      </div>
      
      <div className={styles.content}>
        <span className={styles.value}>{value}</span>
      </div>

      <div className={styles.footer}>
        {trend && (
          <div className={`${styles.trend} ${trend.isPositive ? styles.positive : styles.negative}`}>
            {trend.isPositive ? <TrendingUp size={14} strokeWidth={3} /> : <TrendingDown size={14} strokeWidth={3} />}
            <span>{trend.value}%</span>
          </div>
        )}
        <span className={styles.subtext}>
          {subtext || "vs last month"}
        </span>
      </div>
    </Card>
  );
};
