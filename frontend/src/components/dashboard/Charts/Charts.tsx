'use client';

import React from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Card } from '../../ui/Card/Card';
import styles from './Charts.module.css';

const defaultData = [
  { name: 'Jan', revenue: 4000, expenses: 2400 },
  { name: 'Feb', revenue: 4500, expenses: 2600 },
  { name: 'Mar', revenue: 4200, expenses: 2300 },
  { name: 'Apr', revenue: 5800, expenses: 2800 },
  { name: 'May', revenue: 6200, expenses: 2900 },
  { name: 'Jun', revenue: 7100, expenses: 3100 },
  { name: 'Jul', revenue: 8400, expenses: 3400 },
  { name: 'Aug', revenue: 8100, expenses: 3200 },
  { name: 'Sep', revenue: 9500, expenses: 3600 },
];

const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) => {
  if (active && payload && payload.length) {
    return (
      <div className={styles.customTooltip}>
        <p className={styles.tooltipLabel}>{label}</p>
        <p className={styles.tooltipRevenue}>
          Revenue: <span className={styles.tooltipValue}>${payload[0].value.toLocaleString()}</span>
        </p>
        <p className={styles.tooltipExpenses}>
          Expenses: <span className={styles.tooltipValue}>${payload[1].value.toLocaleString()}</span>
        </p>
      </div>
    );
  }
  return null;
};

interface FinancialChartProps {
  data?: Array<{ name: string; revenue: number; expenses: number }>;
}

export const FinancialChart: React.FC<FinancialChartProps> = ({ data }) => {
  const chartData = data && data.length > 0 ? data : defaultData;
  return (
    <Card className={styles.chartCard}>
      <div className={styles.header}>
        <div>
          <h3 className={styles.title}>Financial Performance</h3>
          <p className={styles.subtitle}>Revenue vs Expenses over time</p>
        </div>
      </div>
      <div className={styles.chartContainer}>
        <ResponsiveContainer width="100%" height={320}>
          <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="colorRev" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.3}/>
                <stop offset="95%" stopColor="var(--primary)" stopOpacity={0}/>
              </linearGradient>
              <linearGradient id="colorExp" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--danger)" stopOpacity={0.2}/>
                <stop offset="95%" stopColor="var(--danger)" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="4 4" vertical={false} stroke="var(--border-color)" opacity={0.5} />
            <XAxis 
              dataKey="name" 
              axisLine={false} 
              tickLine={false} 
              tick={{ fill: 'var(--text-muted)', fontSize: 13, fontFamily: 'var(--font-sans)' }}
              dy={15}
            />
            <YAxis 
              axisLine={false} 
              tickLine={false} 
              tick={{ fill: 'var(--text-muted)', fontSize: 13, fontFamily: 'var(--font-sans)' }}
              tickFormatter={(value) => `$${value}`}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'var(--border-color)', strokeWidth: 1, strokeDasharray: '4 4' }} />
            <Area 
              type="monotone" 
              dataKey="revenue" 
              stroke="var(--primary)" 
              strokeWidth={3}
              fillOpacity={1} 
              fill="url(#colorRev)" 
              activeDot={{ r: 6, strokeWidth: 0, fill: 'var(--primary)' }}
            />
            <Area 
              type="monotone" 
              dataKey="expenses" 
              stroke="var(--danger)" 
              strokeWidth={2}
              fillOpacity={1} 
              fill="url(#colorExp)" 
              activeDot={{ r: 5, strokeWidth: 0, fill: 'var(--danger)' }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
};
