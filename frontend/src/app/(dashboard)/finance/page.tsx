'use client';

import React, { useEffect, useState } from 'react';
import { FinancialChart } from '../../../components/dashboard/Charts/Charts';
import { StatCard } from '../../../components/dashboard/StatCard/StatCard';
import { Wallet, TrendingUp, AlertTriangle, PieChart } from 'lucide-react';
import { apiGet } from '../../../lib/api';
import type { FinanceAnalytics, FinanceIntelligence } from '../../../lib/types';
import styles from './page.module.css';

const money = (value: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value || 0);

export default function FinancePage() {
  const [analytics, setAnalytics] = useState<FinanceAnalytics | null>(null);
  const [intelligence, setIntelligence] = useState<FinanceIntelligence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const [analyticsRes, intelligenceRes] = await Promise.all([
        apiGet<FinanceAnalytics>('/api/finance/analytics'),
        apiGet<FinanceIntelligence>(`/api/finance/intelligence?month=${month}`),
      ]);
      setAnalytics(analyticsRes);
      setIntelligence(intelligenceRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load financial data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onRefresh = () => void load();
    window.addEventListener('oc:data-refresh', onRefresh);
    return () => window.removeEventListener('oc:data-refresh', onRefresh);
  }, [load]);

  if (loading) return <div className={styles.container}>Loading financial intelligence...</div>;
  if (error) return <div className={styles.container}>Unable to load finance module: {error}</div>;

  const trend = (analytics?.monthly_trend || []).map((row) => ({
    name: row.month.slice(5),
    revenue: row.collected,
    expenses: row.overdue,
  }));
  const paid = analytics?.paid_unpaid_ratio.paid || 0;
  const unpaid = analytics?.paid_unpaid_ratio.unpaid || 0;
  const paidRatio = paid + unpaid > 0 ? (paid / (paid + unpaid)) * 100 : 0;
  const netIncome = intelligence?.net_income || 0;

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <h2>Financial Intelligence</h2>
          <p>Detailed breakdown of revenue collection, overdue flow, and unit profitability.</p>
        </div>
      </header>

      <div className={styles.statsGrid}>
        <StatCard title="YTD Collected" value={money(paid)} icon={Wallet} trend={{ value: paidRatio, isPositive: true }} subtext="paid ratio %" />
        <StatCard
          title="Overdue Exposure"
          value={money(unpaid)}
          icon={TrendingUp}
          trend={{ value: 100 - paidRatio, isPositive: false }}
          subtext="unpaid ratio %"
        />
        <StatCard
          title="Current Net Income"
          value={money(netIncome)}
          icon={PieChart}
          trend={{ value: Math.abs(netIncome), isPositive: netIncome >= 0 }}
          subtext="revenue - expenses"
        />
        <StatCard
          title="Total Expenses"
          value={money(intelligence?.expenses || 0)}
          icon={AlertTriangle}
          trend={{ value: intelligence?.expenses || 0, isPositive: false }}
          subtext="selected month"
        />
      </div>

      <div className={styles.mainContent}>
        <div className={styles.chartSection}>
          <FinancialChart data={trend} />
        </div>

        <div className={styles.sideSection}>
          <div className={styles.breakdownCard}>
            <h3 className={styles.breakdownTitle}>Unit Profitability Ranking</h3>
            <div className={styles.expenseList}>
              {(intelligence?.unit_profitability_ranking || []).slice(0, 8).map((item) => (
                <div key={item.unit_id} className={styles.expenseItem}>
                  <div className={styles.expenseInfo}>
                    <div className={styles.expenseDot} style={{ background: 'var(--primary)' }}></div>
                    <span className={styles.expenseLabel}>Unit {item.unit_number}</span>
                  </div>
                  <span className={styles.expenseAmount}>{money(item.net_income)}</span>
                </div>
              ))}
            </div>
            <div className={styles.totalRow}>
              <span>Current Net Income</span>
              <span className={styles.totalAmount}>{money(netIncome)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
