'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useClientAuth } from '../../../lib/client-auth-context';
import styles from './page.module.css';

export default function ClientLoginPage() {
  const router = useRouter();
  const { isAuthenticated, loading, login } = useClientAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && isAuthenticated) router.replace('/client/dashboard');
  }, [isAuthenticated, loading, router]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(email.trim(), password);
      router.replace('/client/dashboard');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.includes('invalid_credentials') ? 'E-mail ou senha inválidos.' : 'Erro ao entrar. Tente novamente.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return null;

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}>OC</div>
        <h1 className={styles.title}>Painel do Cliente</h1>
        <p className={styles.sub}>Oliveira Costa Imóveis</p>
        <form className={styles.form} onSubmit={(e) => void onSubmit(e)}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="email">E-mail</label>
            <input id="email" type="email" className={styles.input} value={email}
              onChange={e => setEmail(e.target.value)} required autoComplete="email" placeholder="seu@email.com" />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="password">Senha</label>
            <input id="password" type="password" className={styles.input} value={password}
              onChange={e => setPassword(e.target.value)} required autoComplete="current-password" placeholder="••••••••" />
          </div>
          {error && <div className={styles.error}>{error}</div>}
          <button type="submit" className={styles.btn} disabled={submitting}>
            {submitting ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  );
}
