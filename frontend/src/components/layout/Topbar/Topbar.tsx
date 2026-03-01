'use client';

import React from 'react';
import { Bell, Menu, Moon, Sun } from 'lucide-react';
import { apiGet } from '../../../lib/api';
import type { NotificationItem } from '../../../lib/types';
import { useTheme } from '../../../lib/theme-context';
import { useAuth } from '../../../lib/auth-context';
import styles from './Topbar.module.css';

interface TopbarProps {
  onMenuClick?: () => void;
  title?: string;
}

export const Topbar: React.FC<TopbarProps> = ({ onMenuClick, title = 'Dashboard' }) => {
  const [hasNotifications, setHasNotifications] = React.useState(false);
  const { theme, toggleTheme } = useTheme();
  const { user } = useAuth();

  React.useEffect(() => {
    let cancelled = false;
    const loadNotifications = async () => {
      try {
        const data = await apiGet<{ items: NotificationItem[] }>('/api/notifications');
        if (!cancelled) {
          setHasNotifications((data.items || []).length > 0);
        }
      } catch {
        if (!cancelled) {
          setHasNotifications(false);
        }
      }
    };

    void loadNotifications();
    const onRefresh = () => void loadNotifications();
    window.addEventListener('oc:data-refresh', onRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener('oc:data-refresh', onRefresh);
    };
  }, []);

  const initials = React.useMemo(() => {
    const base = user?.full_name?.trim() || user?.email || 'User';
    return base.charAt(0).toUpperCase();
  }, [user?.email, user?.full_name]);

  return (
    <header className={styles.topbar}>
      <div className={styles.left}>
        <button className={styles.menuBtn} onClick={onMenuClick}>
          <Menu size={24} />
        </button>
        <h1 className={styles.pageTitle}>{title}</h1>
      </div>

      <div className={styles.right}>
        <button className={styles.iconBtn} onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        <button className={styles.iconBtn} aria-label="Notifications" title="Notifications">
          <Bell size={20} />
          {hasNotifications && <span className={styles.notificationDot}></span>}
        </button>

        <div className={styles.avatar} aria-label={user?.full_name || user?.email || 'User'}>
          {initials}
        </div>
      </div>
    </header>
  );
};
