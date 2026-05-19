'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Megaphone } from 'lucide-react';
import { useClientAuth } from '../../../lib/client-auth-context';
import { clientGet } from '../../../lib/clientApi';
import type { Notice } from '../../../lib/types';
import ClientShell from '../../../components/client/ClientShell/ClientShell';

export default function ClientNoticesPage() {
  const router = useRouter();
  const { isAuthenticated, loading } = useClientAuth();
  const [notices, setNotices] = useState<Notice[]>([]);

  const load = useCallback(async () => {
    const d = await clientGet<{ notices: Notice[] }>('/api/client/notices');
    setNotices(d.notices);
  }, []);

  useEffect(() => {
    if (!loading && !isAuthenticated) router.replace('/client/login');
    if (!loading && isAuthenticated) void load();
  }, [isAuthenticated, loading, router, load]);

  return (
    <ClientShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700 }}>Avisos</h1>

        {notices.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)', fontSize: 14 }}>
            Nenhum aviso no momento.
          </div>
        )}

        {notices.map(n => (
          <div key={n.id} style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', padding: 18, boxShadow: 'var(--shadow-card)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
              <div style={{ width: 36, height: 36, background: 'var(--primary-light)', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Megaphone size={18} color="var(--primary)" />
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{n.title}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{n.created_at.slice(0, 10)}</div>
              </div>
            </div>
            <p style={{ fontSize: 14, color: 'var(--text-main)', lineHeight: 1.6, margin: 0 }}>{n.body}</p>
          </div>
        ))}
      </div>
    </ClientShell>
  );
}
