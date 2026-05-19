'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Wrench, FileText, AlertTriangle, Megaphone } from 'lucide-react';
import { useClientAuth } from '../../../lib/client-auth-context';
import { clientGet } from '../../../lib/clientApi';
import type { ClientDashboard } from '../../../lib/types';
import ClientShell from '../../../components/client/ClientShell/ClientShell';
import PaymentStrip from '../../../components/client/PaymentStrip/PaymentStrip';
import styles from './page.module.css';

const MONTH_LABELS = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

function fmtDate(d: string) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  const mi = parseInt(m, 10) - 1;
  return `${day}/${MONTH_LABELS[mi] ?? m}/${y}`;
}

function daysUntil(d: string): number {
  if (!d) return 0;
  const diff = new Date(d).getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

export default function ClientDashboardPage() {
  const router = useRouter();
  const { isAuthenticated, loading, user } = useClientAuth();
  const [data, setData] = useState<ClientDashboard | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await clientGet<ClientDashboard>('/api/client/dashboard');
      setData(d);
    } catch { setErr('Erro ao carregar.'); }
  }, []);

  useEffect(() => {
    if (!loading && !isAuthenticated) router.replace('/client/login');
    if (!loading && isAuthenticated) void load();
  }, [isAuthenticated, loading, router, load]);

  if (loading || !data) return null;

  const firstName = user?.full_name?.split(' ')[0] ?? 'Cliente';
  const contractDays = data.contract.end ? daysUntil(data.contract.end) : null;

  return (
    <ClientShell>
      <div className={styles.page}>
        <div>
          <h1 className={styles.greeting}>Olá, {firstName} 👋</h1>
          <p className={styles.greetingSub}>Unidade {data.unit.unit_number} · {data.unit.unit_number ? `vence dia ${data.unit.due_day}` : ''}</p>
        </div>

        {/* Next due banner */}
        {data.next_due ? (
          <div className={styles.dueBanner}>
            <div>
              <div className={styles.dueBannerMonth}>Próximo vencimento</div>
              <div className={styles.dueBannerAmount}>R$ {data.next_due.amount.toLocaleString('pt-BR',{minimumFractionDigits:2})}</div>
              <div className={styles.dueBannerLabel}>Vence em {fmtDate(data.next_due.due_date)}</div>
            </div>
            <div style={{textAlign:'right'}}>
              <div style={{fontSize:13,opacity:.9}}>Status</div>
              <div style={{fontWeight:700,fontSize:16}}>{data.next_due.status === 'overdue' ? 'Atrasado' : 'Pendente'}</div>
            </div>
          </div>
        ) : (
          <div className={styles.dueBannerPaid}>
            <div className={styles.dueBannerLabel}>Pagamentos</div>
            <div className={styles.dueBannerAmount}>Em dia ✓</div>
          </div>
        )}

        {/* Stats row */}
        <div className={styles.statsRow}>
          <div className={styles.stat}>
            <div className={styles.statValue}>R$ {data.unit.rent_amount.toLocaleString('pt-BR',{minimumFractionDigits:2})}</div>
            <div className={styles.statLabel}>Aluguel mensal</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statValue}>{contractDays !== null ? `${contractDays}d` : '—'}</div>
            <div className={styles.statLabel}>Dias p/ fim contrato</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statValue}>{data.open_tickets}</div>
            <div className={styles.statLabel}>Chamados abertos</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statValue}>{fmtDate(data.contract.end)}</div>
            <div className={styles.statLabel}>Venc. contrato</div>
          </div>
        </div>

        {/* Payment strip */}
        {data.payment_strip.length > 0 && (
          <div className={styles.card}>
            <div className={styles.cardTitle}>Histórico de pagamentos</div>
            <PaymentStrip items={data.payment_strip} />
          </div>
        )}

        {/* Quick links */}
        <div className={styles.quickLinks}>
          <Link href="/client/tickets/new" className={styles.quickLink}>
            <Wrench size={24} /><span>Abrir chamado</span>
          </Link>
          <Link href="/client/contract" className={styles.quickLink}>
            <FileText size={24} /><span>Contrato</span>
          </Link>
          <Link href="/client/complaints/new" className={styles.quickLink}>
            <AlertTriangle size={24} /><span>Denúncia anônima</span>
          </Link>
          <Link href="/client/notices" className={styles.quickLink}>
            <Megaphone size={24} /><span>Avisos</span>
          </Link>
        </div>

        {err && <p style={{color:'var(--danger)',fontSize:13}}>{err}</p>}
      </div>
    </ClientShell>
  );
}
