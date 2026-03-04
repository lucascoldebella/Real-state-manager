'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Home, Users, Building, PieChart, FileText, Settings, LogOut, Shield } from 'lucide-react';
import { useAuth } from '../../../lib/auth-context';
import type { AccessModule } from '../../../lib/auth-context';
import styles from './Sidebar.module.css';

interface NavItem {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  href: string;
  module: AccessModule;
}

const navItems: NavItem[] = [
  { icon: Home, label: 'Dashboard', href: '/dashboard', module: 'dashboard' },
  { icon: Building, label: 'Properties', href: '/properties', module: 'properties' },
  { icon: Users, label: 'Tenants', href: '/tenants', module: 'tenants' },
  { icon: PieChart, label: 'Finance', href: '/finance', module: 'finance' },
  { icon: FileText, label: 'Documents', href: '/documents', module: 'documents' },
  { icon: Shield, label: 'Security', href: '/security', module: 'settings' as AccessModule },
];

function isActivePath(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  return pathname.startsWith(`${href}/`);
}

export const Sidebar: React.FC = () => {
  const pathname = usePathname();
  const router = useRouter();
  const { user, hasAccess, logout } = useAuth();

  const visibleMain = navItems.filter((item) => hasAccess(item.module));
  const showSettings = hasAccess('settings');

  const onLogout = async () => {
    await logout();
    router.replace('/login');
  };

  return (
    <aside className={styles.sidebar}>
      <div className={styles.header}>
        <div className={styles.logo}>OC</div>
        <div>
          <h2 className={styles.brand}>Oliveira Costa</h2>
          <span className={styles.sectionTitle}>{user?.full_name || user?.email || 'User'}</span>
        </div>
      </div>

      <nav className={styles.nav}>
        <div className={styles.navSection}>
          <span className={styles.sectionTitle}>Main Menu</span>
          <ul className={styles.navList}>
            {visibleMain.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`${styles.navLink} ${isActivePath(pathname, item.href) ? styles.active : ''}`}
                >
                  <item.icon size={20} className={styles.icon} />
                  <span>{item.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <div className={styles.footer}>
        <ul className={styles.navList}>
          {showSettings && (
            <li>
              <Link
                href="/settings"
                className={`${styles.navLink} ${isActivePath(pathname, '/settings') ? styles.active : ''}`}
              >
                <Settings size={20} className={styles.icon} />
                <span>Settings</span>
              </Link>
            </li>
          )}
          <li>
            <button className={`${styles.navLink} ${styles.logoutBtn}`} onClick={() => void onLogout()}>
              <LogOut size={20} className={styles.icon} />
              <span>Logout</span>
            </button>
          </li>
        </ul>
      </div>
    </aside>
  );
};
