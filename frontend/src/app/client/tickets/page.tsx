'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { useClientAuth } from '../../../lib/client-auth-context';
import { clientGet } from '../../../lib/clientApi';
import type { Ticket } from '../../../lib/types';
import ClientShell from '../../../components/client/ClientShell/ClientShell';
import StatusBadge from '../../../components/client/StatusBadge/StatusBadge';

const CAT_LABEL: Record<string, string> = {
  moveis:'Móveis', eletrica:'Elétrica', hidraulica:'Hidráulica', outros:'Outros'
};
const SUB_LABEL: Record<string, string> = { cama:'Cama', fogao:'Fogão', geladeira:'Geladeira', outros:'Outros' };

export default function ClientTicketsPage() {
  const router = useRouter();
  const { isAuthenticated, loading } = useClientAuth();
  const [tickets, setTickets] = useState<Ticket[]>([]);

  const load = useCallback(async () => {
    const d = await clientGet<{ tickets: Ticket[] }>('/api/client/tickets');
    setTickets(d.tickets);
  }, []);

  useEffect(() => {
    if (!loading && !isAuthenticated) router.replace('/client/login');
    if (!loading && isAuthenticated) void load();
  }, [isAuthenticated, loading, router, load]);

  return (
    <ClientShell>
      <div style={{display:'flex',flexDirection:'column',gap:16}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <h1 style={{fontFamily:'var(--font-display)',fontSize:22,fontWeight:700}}>Chamados técnicos</h1>
          <Link href="/client/tickets/new" style={{display:'flex',alignItems:'center',gap:6,background:'var(--primary)',color:'#fff',borderRadius:'var(--radius-md)',padding:'9px 14px',fontSize:13,fontWeight:600,textDecoration:'none'}}>
            <Plus size={16} /> Novo
          </Link>
        </div>

        {tickets.length === 0 && (
          <div style={{textAlign:'center',padding:'48px 0',color:'var(--text-muted)',fontSize:14}}>
            Nenhum chamado aberto. Toque em &quot;Novo&quot; para reportar um problema.
          </div>
        )}

        {tickets.map(t => (
          <div key={t.id} style={{background:'var(--bg-card)',borderRadius:'var(--radius-lg)',padding:16,boxShadow:'var(--shadow-card)'}}>
            <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:8,marginBottom:8}}>
              <div>
                <div style={{fontWeight:600,fontSize:14}}>{CAT_LABEL[t.category] ?? t.category}
                  {t.subcategory ? ` — ${SUB_LABEL[t.subcategory] ?? t.subcategory}` : ''}
                </div>
                <div style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>#{t.id} · {t.created_at.slice(0,10)}</div>
              </div>
              <StatusBadge status={t.status} />
            </div>
            <p style={{fontSize:13,color:'var(--text-muted)',margin:0,overflow:'hidden',textOverflow:'ellipsis',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'}}>
              {t.description}
            </p>
            {t.admin_notes && (
              <div style={{marginTop:10,padding:'8px 12px',background:'var(--info-bg)',borderRadius:'var(--radius-sm)',fontSize:12,color:'var(--info-text)'}}>
                <strong>Admin:</strong> {t.admin_notes}
              </div>
            )}
          </div>
        ))}
      </div>
    </ClientShell>
  );
}
