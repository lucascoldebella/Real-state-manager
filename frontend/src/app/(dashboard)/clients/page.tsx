'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Key, Eye, X, Trash2 } from 'lucide-react';
import { useAuth } from '../../../lib/auth-context';
import { apiDelete, apiGet, apiPost, apiPut } from '../../../lib/api';
import type { Ticket, Complaint, Notice } from '../../../lib/types';
import { Card } from '../../../components/ui/Card/Card';
import { Button } from '../../../components/ui/Button/Button';
import { Modal } from '../../../components/ui/Modal/Modal';
import StatusBadge from '../../../components/client/StatusBadge/StatusBadge';
import styles from './page.module.css';

interface TenantRow {
  id: number;
  full_name: string;
  email: string;
  unit_number: string;
  has_password: boolean;
}

type TabKey = 'tenants' | 'tickets' | 'complaints' | 'notices';

const CAT_LABEL: Record<string, string> = { moveis: 'Móveis', eletrica: 'Elétrica', hidraulica: 'Hidráulica', outros: 'Outros' };
const SUB_LABEL: Record<string, string> = { cama: 'Cama', fogao: 'Fogão', geladeira: 'Geladeira', outros: 'Outros' };

export default function ClientsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  useEffect(() => {
    if (!authLoading && user && !user.permissions.clients && !user.is_root) {
      router.replace('/dashboard');
    }
  }, [authLoading, user, router]);

  const [tab, setTab] = useState<TabKey>('tenants');

  // ── Tenants ──
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [tenantQ, setTenantQ] = useState('');
  const [pwTenant, setPwTenant] = useState<TenantRow | null>(null);
  const [newPw, setNewPw] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState('');
  const [pwErr, setPwErr] = useState('');

  // ── Tickets ──
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketStatus, setTicketStatus] = useState('');
  const [ticketCat, setTicketCat] = useState('');
  const [ticketQ, setTicketQ] = useState('');
  const [ticketDetail, setTicketDetail] = useState<Ticket | null>(null);
  const [ticketNotes, setTicketNotes] = useState('');
  const [ticketStatus2, setTicketStatus2] = useState('');
  const [ticketSaving, setTicketSaving] = useState(false);

  // ── Complaints ──
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [complaintStatus, setComplaintStatus] = useState('');
  const [complaintDetail, setComplaintDetail] = useState<Complaint | null>(null);
  const [complaintNotes, setComplaintNotes] = useState('');
  const [complaintStatus2, setComplaintStatus2] = useState('');
  const [complaintSaving, setComplaintSaving] = useState(false);

  // ── Notices ──
  const [notices, setNotices] = useState<Notice[]>([]);
  const [noticeTitle, setNoticeTitle] = useState('');
  const [noticeBody, setNoticeBody] = useState('');
  const [noticeSaving, setNoticeSaving] = useState(false);

  // ── Load ──
  const loadTenants = useCallback(async () => {
    const d = await apiGet<{ tenants: TenantRow[] }>('/api/clients/tenants');
    setTenants(d.tenants ?? []);
  }, []);

  const loadTickets = useCallback(async () => {
    const params = new URLSearchParams();
    if (ticketStatus) params.set('status', ticketStatus);
    if (ticketCat) params.set('category', ticketCat);
    const d = await apiGet<{ tickets: Ticket[] }>(`/api/clients/tickets?${params}`);
    setTickets(d.tickets ?? []);
  }, [ticketStatus, ticketCat]);

  const loadComplaints = useCallback(async () => {
    const params = new URLSearchParams();
    if (complaintStatus) params.set('status', complaintStatus);
    const d = await apiGet<{ complaints: Complaint[] }>(`/api/clients/complaints?${params}`);
    setComplaints(d.complaints ?? []);
  }, [complaintStatus]);

  const loadNotices = useCallback(async () => {
    const d = await apiGet<{ notices: Notice[] }>('/api/clients/notices');
    setNotices(d.notices ?? []);
  }, []);

  useEffect(() => { void loadTenants(); }, [loadTenants]);
  useEffect(() => { if (tab === 'tickets') void loadTickets(); }, [tab, loadTickets]);
  useEffect(() => { if (tab === 'complaints') void loadComplaints(); }, [tab, loadComplaints]);
  useEffect(() => { if (tab === 'notices') void loadNotices(); }, [tab, loadNotices]);

  // ── Handlers ──
  const handleSetPassword = async () => {
    if (!pwTenant) return;
    if (newPw.length < 6) { setPwErr('Mínimo 6 caracteres.'); return; }
    setPwSaving(true); setPwErr(''); setPwMsg('');
    try {
      await apiPost(`/api/clients/tenants/${pwTenant.id}/password`, { password: newPw });
      setPwMsg('Senha definida com sucesso.');
      setNewPw('');
      void loadTenants();
    } catch (e: unknown) {
      setPwErr(e instanceof Error ? e.message : String(e));
    } finally { setPwSaving(false); }
  };

  const handleUpdateTicket = async () => {
    if (!ticketDetail) return;
    setTicketSaving(true);
    try {
      await apiPut(`/api/clients/tickets/${ticketDetail.id}`, { status: ticketStatus2, admin_notes: ticketNotes });
      setTicketDetail(null);
      void loadTickets();
    } finally { setTicketSaving(false); }
  };

  const handleUpdateComplaint = async () => {
    if (!complaintDetail) return;
    setComplaintSaving(true);
    try {
      await apiPut(`/api/clients/complaints/${complaintDetail.id}`, { status: complaintStatus2, admin_notes: complaintNotes });
      setComplaintDetail(null);
      void loadComplaints();
    } finally { setComplaintSaving(false); }
  };

  const handleCreateNotice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!noticeTitle.trim() || !noticeBody.trim()) return;
    setNoticeSaving(true);
    try {
      await apiPost('/api/clients/notices', { title: noticeTitle, body: noticeBody });
      setNoticeTitle(''); setNoticeBody('');
      void loadNotices();
    } finally { setNoticeSaving(false); }
  };

  const handleDeleteNotice = async (id: number) => {
    if (!confirm('Excluir aviso?')) return;
    await apiDelete(`/api/clients/notices/${id}`);
    void loadNotices();
  };

  const handleDeleteTicket = async (id: number) => {
    if (!confirm(`Excluir permanentemente o chamado #${id}? Esta ação não pode ser desfeita.`)) return;
    await apiDelete(`/api/clients/tickets/${id}`);
    setTicketDetail(null);
    void loadTickets();
  };

  const handleDeleteComplaint = async (id: number) => {
    if (!confirm(`Excluir permanentemente a denúncia #${id}? Esta ação não pode ser desfeita.`)) return;
    await apiDelete(`/api/clients/complaints/${id}`);
    setComplaintDetail(null);
    void loadComplaints();
  };

  const filteredTenants = tenants.filter(t =>
    !tenantQ || t.full_name.toLowerCase().includes(tenantQ.toLowerCase()) || t.email.toLowerCase().includes(tenantQ.toLowerCase())
  );

  const filteredTickets = tickets.filter(t =>
    !ticketQ || t.tenant_name?.toLowerCase().includes(ticketQ.toLowerCase()) || String(t.id).includes(ticketQ)
  );

  const inputStyle: React.CSSProperties = {
    border: '1.5px solid var(--border-color)', borderRadius: 'var(--radius-md)',
    padding: '9px 12px', fontSize: 14, color: 'var(--text-main)', background: 'var(--bg-main)', fontFamily: 'inherit',
  };

  const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' };

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '8px 16px', fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer',
    borderRadius: 'var(--radius-md)', background: active ? 'var(--primary)' : 'transparent',
    color: active ? '#fff' : 'var(--text-muted)',
    transition: 'all var(--transition-fast)',
  });

  if (authLoading) return null;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerTitle}>
          <h2>Client Panel</h2>
          <p>Gerencie o portal de inquilinos</p>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(['tenants', 'tickets', 'complaints', 'notices'] as TabKey[]).map(t => (
          <button key={t} style={tabStyle(tab === t)} onClick={() => setTab(t)}>
            {{ tenants: 'Inquilinos', tickets: 'Chamados', complaints: 'Denúncias', notices: 'Avisos' }[t]}
          </button>
        ))}
      </div>

      {/* ── TENANTS TAB ── */}
      {tab === 'tenants' && (
        <Card>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input style={{ ...inputStyle, paddingLeft: 32, width: '100%' }} placeholder="Buscar inquilino…" value={tenantQ} onChange={e => setTenantQ(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filteredTenants.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Nenhum inquilino encontrado.</p>}
            {filteredTenants.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{t.full_name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t.email} · Unidade {t.unit_number || '—'}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 'var(--radius-full)', background: t.has_password ? 'var(--success-bg)' : 'var(--warning-bg)', color: t.has_password ? 'var(--success-text)' : 'var(--warning-text)', fontWeight: 600 }}>
                    {t.has_password ? 'Senha definida' : 'Sem senha'}
                  </span>
                  <Button size="sm" variant="outline" onClick={() => { setPwTenant(t); setNewPw(''); setPwMsg(''); setPwErr(''); }}>
                    <Key size={13} /> {t.has_password ? 'Redefinir' : 'Definir senha'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── TICKETS TAB ── */}
      {tab === 'tickets' && (
        <Card>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input style={{ ...inputStyle, paddingLeft: 32, width: '100%' }} placeholder="Inquilino ou #ID…" value={ticketQ} onChange={e => setTicketQ(e.target.value)} />
            </div>
            <select style={selectStyle} value={ticketStatus} onChange={e => { setTicketStatus(e.target.value); }}>
              <option value="">Todos os status</option>
              <option value="open">Aberto</option>
              <option value="in_progress">Em andamento</option>
              <option value="resolved">Resolvido</option>
              <option value="closed">Fechado</option>
            </select>
            <select style={selectStyle} value={ticketCat} onChange={e => { setTicketCat(e.target.value); }}>
              <option value="">Todas categorias</option>
              <option value="moveis">Móveis</option>
              <option value="eletrica">Elétrica</option>
              <option value="hidraulica">Hidráulica</option>
              <option value="outros">Outros</option>
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filteredTickets.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Nenhum chamado encontrado.</p>}
            {filteredTickets.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '12px 16px', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>#{t.id} · {CAT_LABEL[t.category] ?? t.category}{t.subcategory ? ` — ${SUB_LABEL[t.subcategory]}` : ''}</span>
                    <StatusBadge status={t.status} />
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{t.tenant_name ?? '—'} · {t.created_at.slice(0, 10)}</div>
                  <p style={{ fontSize: 13, color: 'var(--text-main)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{t.description}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => { setTicketDetail(t); setTicketNotes(t.admin_notes); setTicketStatus2(t.status); }}>
                  <Eye size={13} /> Ver
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── COMPLAINTS TAB ── */}
      {tab === 'complaints' && (
        <Card>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <select style={selectStyle} value={complaintStatus} onChange={e => { setComplaintStatus(e.target.value); }}>
              <option value="">Todos os status</option>
              <option value="new">Novo</option>
              <option value="reviewed">Analisado</option>
              <option value="archived">Arquivado</option>
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {complaints.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Nenhuma denúncia encontrada.</p>}
            {complaints.map(c => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '12px 16px', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>#{c.id}</span>
                    <StatusBadge status={c.status} />
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.created_at.slice(0, 10)}</span>
                  </div>
                  <p style={{ fontSize: 13, color: 'var(--text-main)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{c.body}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => { setComplaintDetail(c); setComplaintNotes(c.admin_notes); setComplaintStatus2(c.status); }}>
                  <Eye size={13} /> Ver
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── NOTICES TAB ── */}
      {tab === 'notices' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14 }}>Novo aviso</div>
            <form onSubmit={e => void handleCreateNotice(e)} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input style={inputStyle} placeholder="Título" value={noticeTitle} onChange={e => setNoticeTitle(e.target.value)} maxLength={120} required />
              <textarea style={{ ...inputStyle, resize: 'vertical' }} rows={4} placeholder="Conteúdo do aviso…" value={noticeBody} onChange={e => setNoticeBody(e.target.value)} maxLength={2000} required />
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button type="submit" disabled={noticeSaving}>{noticeSaving ? 'Publicando…' : 'Publicar aviso'}</Button>
              </div>
            </form>
          </Card>

          <Card>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14 }}>Avisos publicados</div>
            {notices.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Nenhum aviso.</p>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {notices.map(n => (
                <div key={n.id} style={{ padding: '12px 14px', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{n.title}</div>
                    <button onClick={() => void handleDeleteNotice(n.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', padding: 4 }}>
                      <X size={14} />
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{n.created_at.slice(0, 10)}</div>
                  <p style={{ fontSize: 13, color: 'var(--text-main)', margin: 0, lineHeight: 1.5 }}>{n.body}</p>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ── PASSWORD MODAL ── */}
      <Modal isOpen={!!pwTenant} onClose={() => setPwTenant(null)} title={`Senha — ${pwTenant?.full_name ?? ''}`}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
            Defina a senha de acesso ao portal do inquilino. Repasse a senha ao inquilino fora do sistema.
          </p>
          <input type="password" style={inputStyle} placeholder="Nova senha (mín. 6 caracteres)" value={newPw} onChange={e => setNewPw(e.target.value)} />
          {pwErr && <p style={{ color: 'var(--danger)', fontSize: 13, margin: 0 }}>{pwErr}</p>}
          {pwMsg && <p style={{ color: 'var(--success)', fontSize: 13, margin: 0 }}>{pwMsg}</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="outline" onClick={() => setPwTenant(null)}>Cancelar</Button>
            <Button onClick={() => void handleSetPassword()} disabled={pwSaving}>{pwSaving ? 'Salvando…' : 'Definir senha'}</Button>
          </div>
        </div>
      </Modal>

      {/* ── TICKET DETAIL MODAL ── */}
      <Modal isOpen={!!ticketDetail} onClose={() => setTicketDetail(null)} title={`Chamado #${ticketDetail?.id ?? ''}`}>
        {ticketDetail && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Inquilino</div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{ticketDetail.tenant_name ?? '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Categoria</div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{CAT_LABEL[ticketDetail.category]}{ticketDetail.subcategory ? ` — ${SUB_LABEL[ticketDetail.subcategory]}` : ''}</div>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Descrição</div>
              <p style={{ fontSize: 14, color: 'var(--text-main)', margin: 0, lineHeight: 1.6 }}>{ticketDetail.description}</p>
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>Status</label>
              <select style={selectStyle} value={ticketStatus2} onChange={e => setTicketStatus2(e.target.value)}>
                <option value="open">Aberto</option>
                <option value="in_progress">Em andamento</option>
                <option value="resolved">Resolvido</option>
                <option value="closed">Fechado</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>Notas internas</label>
              <textarea style={{ ...inputStyle, resize: 'vertical', width: '100%' }} rows={3} value={ticketNotes} onChange={e => setTicketNotes(e.target.value)} placeholder="Notas visíveis para o inquilino…" />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <Button variant="danger" size="sm" onClick={() => ticketDetail && void handleDeleteTicket(ticketDetail.id)}>
                <Trash2 size={14} /> Excluir
              </Button>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="outline" onClick={() => setTicketDetail(null)}>Cancelar</Button>
                <Button onClick={() => void handleUpdateTicket()} disabled={ticketSaving}>{ticketSaving ? 'Salvando…' : 'Salvar'}</Button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* ── COMPLAINT DETAIL MODAL ── */}
      <Modal isOpen={!!complaintDetail} onClose={() => setComplaintDetail(null)} title={`Denúncia #${complaintDetail?.id ?? ''}`}>
        {complaintDetail && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ background: 'var(--warning-bg)', borderRadius: 'var(--radius-md)', padding: '10px 14px', fontSize: 12, color: 'var(--warning-text)' }}>
              Identidade do denunciante anonimizada. Nenhuma informação pessoal foi armazenada.
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Relato</div>
              <p style={{ fontSize: 14, color: 'var(--text-main)', margin: 0, lineHeight: 1.6 }}>{complaintDetail.body}</p>
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>Status</label>
              <select style={selectStyle} value={complaintStatus2} onChange={e => setComplaintStatus2(e.target.value)}>
                <option value="new">Novo</option>
                <option value="reviewed">Analisado</option>
                <option value="archived">Arquivado</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>Notas internas</label>
              <textarea style={{ ...inputStyle, resize: 'vertical', width: '100%' }} rows={3} value={complaintNotes} onChange={e => setComplaintNotes(e.target.value)} placeholder="Observações internas…" />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <Button variant="danger" size="sm" onClick={() => complaintDetail && void handleDeleteComplaint(complaintDetail.id)}>
                <Trash2 size={14} /> Excluir
              </Button>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="outline" onClick={() => setComplaintDetail(null)}>Cancelar</Button>
                <Button onClick={() => void handleUpdateComplaint()} disabled={complaintSaving}>{complaintSaving ? 'Salvando…' : 'Salvar'}</Button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
