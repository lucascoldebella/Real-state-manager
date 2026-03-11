'use client';

import React, { useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Sidebar } from '../Sidebar/Sidebar';
import { Topbar } from '../Topbar/Topbar';
import { useAuth } from '../../../lib/auth-context';
import type { AccessModule } from '../../../lib/auth-context';
import styles from './DashboardLayout.module.css';

interface DashboardLayoutProps {
  children: React.ReactNode;
}

const accessOrder: Array<{ href: string; module: AccessModule }> = [
  { href: '/dashboard', module: 'dashboard' },
  { href: '/properties', module: 'properties' },
  { href: '/tenants', module: 'tenants' },
  { href: '/finance', module: 'finance' },
  { href: '/documents', module: 'documents' },
  { href: '/settings', module: 'settings' },
];

function getTitle(pathname: string): string {
  if (pathname.startsWith('/properties')) return 'Properties';
  if (pathname.startsWith('/tenants')) return 'Tenants';
  if (pathname.startsWith('/finance')) return 'Finance';
  if (pathname.startsWith('/documents')) return 'Documents';
  if (pathname.startsWith('/settings')) return 'Settings';
  if (pathname.startsWith('/security')) return 'Security Monitor';
  return 'Dashboard';
}

function getRequiredModule(pathname: string): AccessModule {
  if (pathname.startsWith('/properties')) return 'properties';
  if (pathname.startsWith('/tenants')) return 'tenants';
  if (pathname.startsWith('/finance')) return 'finance';
  if (pathname.startsWith('/documents')) return 'documents';
  if (pathname.startsWith('/settings')) return 'settings';
  if (pathname.startsWith('/security')) return 'settings';
  return 'dashboard';
}

export const DashboardLayout: React.FC<DashboardLayoutProps> = ({ children }) => {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const { loading, isAuthenticated, hasAccess } = useAuth();

  const requiredModule = getRequiredModule(pathname);
  const pageTitle = getTitle(pathname);

  const fallbackPath = useMemo(() => {
    const first = accessOrder.find((item) => hasAccess(item.module));
    return first?.href || '/login';
  }, [hasAccess]);

  React.useEffect(() => {
    if (!loading && !isAuthenticated) {
      router.replace('/login');
    }
  }, [isAuthenticated, loading, router]);

  React.useEffect(() => {
    if (!loading && isAuthenticated && !hasAccess(requiredModule)) {
      router.replace(fallbackPath);
    }
  }, [fallbackPath, hasAccess, isAuthenticated, loading, requiredModule, router]);

  React.useEffect(() => {
    setIsSidebarOpen(false);
  }, [pathname]);

  if (loading || !isAuthenticated) {
    return <div className={styles.loadingState}>Checking session...</div>;
  }

  return (
    <div className={styles.layout}>
      <div className={`${styles.sidebarWrapper} ${isSidebarOpen ? styles.open : ''}`}>
        <Sidebar />
      </div>

      {isSidebarOpen && <div className={styles.overlay} onClick={() => setIsSidebarOpen(false)} />}

      <main className={styles.main}>
        <Topbar onMenuClick={() => setIsSidebarOpen(true)} title={pageTitle} />
        <div className={styles.content}>
          <div className="animate-fade-in">{children}</div>
        </div>
      </main>
    </div>
  );
};
