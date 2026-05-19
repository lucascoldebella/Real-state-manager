'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, FileText } from 'lucide-react';
import { useClientAuth } from '../../../lib/client-auth-context';
import { clientGet, getClientToken } from '../../../lib/clientApi';
import ClientShell from '../../../components/client/ClientShell/ClientShell';

interface ContractInfo {
  contract: { id?: number; available?: boolean; generated_at?: string };
  receipts: { id: number; reference_month: string; generated_at: string }[];
}

const API = process.env.NEXT_PUBLIC_API_URL ?? '';

async function downloadDoc(id: number, name: string) {
  const token = getClientToken();
  const res = await fetch(`${API}/api/client/documents/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) { alert('Erro ao baixar documento.'); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

const MONTHS = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
function fmtMonth(m: string) {
  const [y, mo] = m.split('-');
  return `${MONTHS[parseInt(mo,10)-1] ?? mo}/${y}`;
}

export default function ClientContractPage() {
  const router = useRouter();
  const { isAuthenticated, loading } = useClientAuth();
  const [data, setData] = useState<ContractInfo | null>(null);

  const load = useCallback(async () => {
    const d = await clientGet<ContractInfo>('/api/client/contract');
    setData(d);
  }, []);

  useEffect(() => {
    if (!loading && !isAuthenticated) router.replace('/client/login');
    if (!loading && isAuthenticated) void load();
  }, [isAuthenticated, loading, router, load]);

  if (loading || !data) return null;

  return (
    <ClientShell>
      <div style={{display:'flex',flexDirection:'column',gap:20}}>
        <h1 style={{fontFamily:'var(--font-display)',fontSize:22,fontWeight:700}}>Contrato &amp; Recibos</h1>

        {/* Contract */}
        <div style={{background:'var(--bg-card)',borderRadius:'var(--radius-lg)',padding:20,boxShadow:'var(--shadow-card)'}}>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12}}>
            <div style={{width:44,height:44,background:'var(--primary-light)',borderRadius:'var(--radius-md)',display:'flex',alignItems:'center',justifyContent:'center'}}>
              <FileText size={22} color="var(--primary)" />
            </div>
            <div>
              <div style={{fontFamily:'var(--font-display)',fontWeight:700,fontSize:16}}>Contrato de Locação</div>
              <div style={{fontSize:12,color:'var(--text-muted)'}}>Documento atual</div>
            </div>
          </div>
          {data.contract.available && data.contract.id ? (
            <button
              onClick={() => void downloadDoc(data.contract.id!, 'contrato.pdf')}
              style={{display:'flex',alignItems:'center',gap:8,background:'var(--primary)',color:'#fff',border:'none',borderRadius:'var(--radius-md)',padding:'10px 18px',fontSize:14,fontWeight:600,cursor:'pointer',width:'100%',justifyContent:'center'}}
            >
              <Download size={16} /> Baixar PDF
            </button>
          ) : (
            <p style={{fontSize:13,color:'var(--text-muted)'}}>Contrato ainda não disponível. Contate o administrador.</p>
          )}
        </div>

        {/* Receipts */}
        <div style={{background:'var(--bg-card)',borderRadius:'var(--radius-lg)',padding:20,boxShadow:'var(--shadow-card)'}}>
          <div style={{fontFamily:'var(--font-display)',fontWeight:700,fontSize:16,marginBottom:14}}>Recibos de pagamento</div>
          {data.receipts.length === 0 ? (
            <p style={{fontSize:13,color:'var(--text-muted)'}}>Nenhum recibo disponível.</p>
          ) : (
            <div style={{display:'flex',flexDirection:'column',gap:10}}>
              {data.receipts.map(r => (
                <div key={r.id} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 0',borderBottom:'1px solid var(--border-color)'}}>
                  <div>
                    <div style={{fontWeight:600,fontSize:14}}>{fmtMonth(r.reference_month)}</div>
                    <div style={{fontSize:11,color:'var(--text-muted)'}}>{r.generated_at.slice(0,10)}</div>
                  </div>
                  <button
                    onClick={() => void downloadDoc(r.id, `recibo-${r.reference_month}.pdf`)}
                    style={{display:'flex',alignItems:'center',gap:6,background:'none',border:'1px solid var(--primary)',color:'var(--primary)',borderRadius:'var(--radius-md)',padding:'7px 14px',fontSize:12,fontWeight:600,cursor:'pointer'}}
                  >
                    <Download size={14} /> Baixar
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </ClientShell>
  );
}
