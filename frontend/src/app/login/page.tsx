'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Mail } from 'lucide-react';
import { useAuth } from '../../lib/auth-context';
import styles from './page.module.css';

const FALLBACK_ORDER: Array<{ href: string; module: 'dashboard' | 'properties' | 'tenants' | 'finance' | 'documents' | 'settings' }> = [
  { href: '/dashboard', module: 'dashboard' },
  { href: '/properties', module: 'properties' },
  { href: '/tenants', module: 'tenants' },
  { href: '/finance', module: 'finance' },
  { href: '/documents', module: 'documents' },
  { href: '/settings', module: 'settings' },
];

export default function LoginPage() {
  const router = useRouter();
  const { login, loading, isAuthenticated, hasAccess } = useAuth();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  const nextPath = React.useMemo(() => {
    const first = FALLBACK_ORDER.find((item) => hasAccess(item.module));
    return first?.href || '/dashboard';
  }, [hasAccess]);

  React.useEffect(() => {
    if (!loading && isAuthenticated) {
      router.replace(nextPath);
    }
  }, [isAuthenticated, loading, nextPath, router]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await login(email.trim(), password);
      router.replace(nextPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.backdrop}></div>
      <div className={styles.card}>
        <div className={styles.brand}>OC</div>
        <h1 className={styles.title}>Oliveira Costa</h1>
        <p className={styles.subtitle}>Sign in to access your real estate control center.</p>

        <form className={styles.form} onSubmit={onSubmit}>
          {error && <div className={styles.error}>{error}</div>}

          <label className={styles.field}>
            <span>Email</span>
            <div className={styles.inputWrap}>
              <Mail size={16} />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
                required
              />
            </div>
          </label>

          <label className={styles.field}>
            <span>Password</span>
            <div className={styles.inputWrap}>
              <Lock size={16} />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
              />
            </div>
          </label>

          <button type="submit" className={styles.submit} disabled={submitting || loading}>
            {submitting ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
