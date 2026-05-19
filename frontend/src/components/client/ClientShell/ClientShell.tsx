'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Home, Wrench, AlertTriangle, FileText, User, Bell, LogOut, Megaphone } from 'lucide-react';
import { useClientAuth } from '../../../lib/client-auth-context';
import styles from './ClientShell.module.css';

const primaryNav = [
  { icon: Home, label: 'Início', href: '/client/dashboard' },
  { icon: Wrench, label: 'Chamados', href: '/client/tickets' },
  { icon: AlertTriangle, label: 'Denúncia', href: '/client/complaints/new' },
  { icon: FileText, label: 'Contrato', href: '/client/contract' },
  { icon: User, label: 'Perfil', href: '/client/profile' },
];

const secondaryNav = [
  { icon: Megaphone, label: 'Avisos', href: '/client/notices' },
  { icon: Bell, label: 'Notificações', href: '/client/notifications' },
];

export default function ClientShell({
  children,
  hasUnread,
}: {
  children: React.ReactNode;
  hasUnread?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useClientAuth();

  const onLogout = async () => {
    await logout();
    router.replace('/client/login');
  };

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  const firstName = user?.full_name?.split(' ')[0] ?? 'Cliente';

  return (
    <div className={styles.shell}>
      {/* Desktop sidebar */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarBrand}>
          <div className={styles.sidebarLogo}>OC</div>
          <div>
            <div className={styles.sidebarBrandText}>Oliveira Costa</div>
            <div className={styles.sidebarBrandSub}>Portal do Cliente</div>
          </div>
        </div>

        <nav className={styles.sidebarNav}>
          <span className={styles.sidebarSectionLabel}>Menu</span>
          {primaryNav.map(({ icon: Icon, label, href }) => (
            <Link
              key={href}
              href={href}
              className={`${styles.sidebarItem} ${isActive(href) ? styles.active : ''}`}
            >
              <Icon size={18} />
              <span>{label}</span>
            </Link>
          ))}

          <span className={styles.sidebarSectionLabel} style={{ marginTop: 16 }}>
            Informativos
          </span>
          {secondaryNav.map(({ icon: Icon, label, href }) => (
            <Link
              key={href}
              href={href}
              className={`${styles.sidebarItem} ${isActive(href) ? styles.active : ''}`}
            >
              <Icon size={18} />
              <span>{label}</span>
              {href === '/client/notifications' && hasUnread && (
                <span
                  className={styles.notifDot}
                  style={{ position: 'static', border: 'none' }}
                />
              )}
            </Link>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.sidebarUser}>
            <div className={styles.sidebarUserName}>{user?.full_name ?? 'Cliente'}</div>
            <div className={styles.sidebarUserEmail}>{user?.email ?? ''}</div>
          </div>
          <button className={styles.logoutBtn} onClick={() => void onLogout()}>
            <LogOut size={18} />
            <span>Sair</span>
          </button>
        </div>
      </aside>

      {/* Mobile topbar */}
      <header className={styles.topbar}>
        <div className={styles.topbarBrand}>
          <div className={styles.topbarLogo}>OC</div>
          <span className={styles.topbarTitle}>Olá, {firstName}</span>
        </div>
        <div className={styles.topbarActions}>
          <Link href="/client/notices" className={styles.notifBtn} aria-label="Avisos">
            <Megaphone size={20} />
          </Link>
          <Link href="/client/notifications" className={styles.notifBtn} aria-label="Notificações">
            <Bell size={20} />
            {hasUnread && <span className={styles.notifDot} />}
          </Link>
        </div>
      </header>

      <div className={styles.contentArea}>
        <main className={styles.main}>{children}</main>
      </div>

      {/* Mobile bottom nav */}
      <nav className={styles.bottomNav}>
        {primaryNav.map(({ icon: Icon, label, href }) => (
          <Link
            key={href}
            href={href}
            className={`${styles.navItem} ${isActive(href) ? styles.active : ''}`}
          >
            <Icon />
            <span>{label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
