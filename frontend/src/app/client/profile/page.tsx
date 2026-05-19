'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useClientAuth } from '../../../lib/client-auth-context';
import { clientPut, clearClientSession } from '../../../lib/clientApi';
import ClientShell from '../../../components/client/ClientShell/ClientShell';

export default function ClientProfilePage() {
  const router = useRouter();
  const { isAuthenticated, loading, user } = useClientAuth();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!loading && !isAuthenticated) router.replace('/client/login');
  }, [isAuthenticated, loading, router]);

  const handleLogout = () => {
    clearClientSession();
    router.replace('/client/login');
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(''); setErr('');
    if (next.length < 6) { setErr('Nova senha deve ter pelo menos 6 caracteres.'); return; }
    if (next !== confirm) { setErr('As senhas não coincidem.'); return; }
    setSaving(true);
    try {
      await clientPut('/api/client/auth/password', { current_password: current, new_password: next });
      setMsg('Senha alterada com sucesso.');
      setCurrent(''); setNext(''); setConfirm('');
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  };

  if (loading) return null;

  const inputStyle: React.CSSProperties = {
    border: '1.5px solid var(--border-color)', borderRadius: 'var(--radius-md)',
    padding: '11px 14px', fontSize: 16, width: '100%',
    color: 'var(--text-main)', background: 'var(--bg-main)', fontFamily: 'inherit',
  };

  return (
    <ClientShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 480 }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700 }}>Perfil</h1>

        {/* Info card */}
        <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', padding: 20, boxShadow: 'var(--shadow-card)' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, marginBottom: 14 }}>Meus dados</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>Nome</div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{user?.full_name ?? '—'}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>E-mail</div>
              <div style={{ fontSize: 15 }}>{user?.email ?? '—'}</div>
            </div>
          </div>
        </div>

        {/* Change password */}
        <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', padding: 20, boxShadow: 'var(--shadow-card)' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, marginBottom: 14 }}>Alterar senha</div>
          <form onSubmit={e => void handleChangePassword(e)} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input type="password" placeholder="Senha atual" value={current} onChange={e => setCurrent(e.target.value)} style={inputStyle} required />
            <input type="password" placeholder="Nova senha" value={next} onChange={e => setNext(e.target.value)} style={inputStyle} required />
            <input type="password" placeholder="Confirmar nova senha" value={confirm} onChange={e => setConfirm(e.target.value)} style={inputStyle} required />
            {err && <p style={{ color: 'var(--danger)', fontSize: 13, margin: 0 }}>{err}</p>}
            {msg && <p style={{ color: 'var(--success)', fontSize: 13, margin: 0 }}>{msg}</p>}
            <button type="submit" disabled={saving}
              style={{ background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', padding: '12px', fontSize: 14, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
              {saving ? 'Salvando…' : 'Salvar nova senha'}
            </button>
          </form>
        </div>

        {/* Logout */}
        <button onClick={handleLogout}
          style={{ background: 'none', border: '1.5px solid var(--danger)', color: 'var(--danger)', borderRadius: 'var(--radius-md)', padding: '12px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
          Sair da conta
        </button>
      </div>
    </ClientShell>
  );
}
