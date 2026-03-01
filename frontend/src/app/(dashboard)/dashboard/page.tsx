'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { StatCard } from '../../../components/dashboard/StatCard/StatCard';
import { UnitGrid } from '../../../components/dashboard/UnitGrid/UnitGrid';
import { FinancialChart } from '../../../components/dashboard/Charts/Charts';
import { Wallet, AlertTriangle, Home, ArrowUpRight, CheckCircle2 } from 'lucide-react';
import { apiGet } from '../../../lib/api';
import type { DashboardGridItem, DashboardSummary, FinanceAnalytics, NotificationItem } from '../../../lib/types';
import styles from './page.module.css';

const money = (value: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value || 0);

const shortDateTime = (value: string): string => {
  if (!value) return '-';
  const date = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

export default function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [grid, setGrid] = useState<DashboardGridItem[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [trend, setTrend] = useState<Array<{ name: string; revenue: number; expenses: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [dashboard, noticeData, analytics] = await Promise.all([
        apiGet<{ month: string; summary: DashboardSummary; unit_grid: DashboardGridItem[] }>('/api/dashboard/summary'),
        apiGet<{ items: NotificationItem[] }>('/api/notifications'),
        apiGet<FinanceAnalytics>('/api/finance/analytics'),
      ]);

      setSummary(dashboard.summary);
      setGrid(dashboard.unit_grid || []);
      setNotifications(noticeData.items || []);

      const series = (analytics.monthly_trend || []).map((row) => ({
        name: row.month.slice(5),
        revenue: row.collected,
        expenses: row.overdue,
      }));
      setTrend(series);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onRefresh = () => void load();
    window.addEventListener('oc:data-refresh', onRefresh);
    return () => {
      window.removeEventListener('oc:data-refresh', onRefresh);
    };
  }, [load]);

  const collectionTrend = useMemo(() => {
    const value = summary?.revenue_vs_previous_month_pct ?? 0;
    return { value: Math.abs(Number(value.toFixed(1))), isPositive: value >= 0 };
  }, [summary?.revenue_vs_previous_month_pct]);

  if (loading) {
    return <div className={styles.container}>Loading dashboard...</div>;
  }

  if (error) {
    return <div className={styles.container}>Unable to load dashboard: {error}</div>;
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h2 className={styles.title}>Welcome back, Oliveira Costa</h2>
        <p className={styles.subtitle}>Here is your property portfolio overview for this month.</p>
      </header>

      <div className={styles.statsGrid}>
        <StatCard
          title="Expected Rent"
          value={money(summary?.expected_rent || 0)}
          icon={Wallet}
          trend={collectionTrend}
          subtext="vs previous month"
        />
        <StatCard
          title="Collection Rate"
          value={`${(summary?.collection_percentage || 0).toFixed(1)}%`}
          icon={Home}
          trend={{ value: (summary?.paid_tenants || 0) || 0, isPositive: true }}
          subtext="paid tenants"
        />
        <StatCard
          title="Active Tenants"
          value={String(summary?.total_tenants || 0)}
          icon={CheckCircle2}
          trend={{ value: summary?.contracts_expiring_soon || 0, isPositive: false }}
          subtext="contracts expiring soon"
        />
        <StatCard
          title="Overdue Amount"
          value={money(summary?.overdue || 0)}
          icon={AlertTriangle}
          trend={{ value: summary?.overdue_tenants || 0, isPositive: false }}
          subtext="tenants overdue"
        />
      </div>

      <div className={styles.mainContent}>
        <div className={styles.chartSection}>
          <FinancialChart data={trend} />
        </div>
        <div className={styles.sideSection}>
          <div className={styles.activityCard}>
            <div className={styles.activityHeader}>
              <h3 className={styles.activityTitle}>Notifications</h3>
              <button className={styles.viewAllBtn} onClick={() => void load()}>
                Refresh <ArrowUpRight size={16} />
              </button>
            </div>
            <div className={styles.activityList}>
              {(notifications || []).slice(0, 6).map((item) => (
                <div key={item.id} className={styles.activityItem}>
                  <div className={`${styles.activityDot} ${styles[`dot-${item.type === 'overdue' ? 'danger' : 'warning'}`]}`} />
                  <div className={styles.activityContent}>
                    <div className={styles.activityTop}>
                      <span className={styles.activityItemTitle}>{item.title}</span>
                      <span className={styles.activityTime}>{shortDateTime(item.created_at)}</span>
                    </div>
                    <span className={styles.activityDesc}>{item.message}</span>
                  </div>
                </div>
              ))}
              {notifications.length === 0 && <div className={styles.activityDesc}>No notifications right now.</div>}
            </div>
          </div>
        </div>
      </div>

      <div className={styles.gridSection}>
        <UnitGrid
          items={grid}
          subtitle={`Active: ${summary?.total_tenants || 0} tenants • Vacant: ${summary?.vacant_units || 0} • Disabled: ${
            summary?.disabled_units || 0
          }`}
        />
      </div>
    </div>
  );
}
