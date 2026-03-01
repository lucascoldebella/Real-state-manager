'use client';

import React from 'react';
import { Plus, Pencil, UserX } from 'lucide-react';
import { Card } from '../../../components/ui/Card/Card';
import { Modal } from '../../../components/ui/Modal/Modal';
import { Button } from '../../../components/ui/Button/Button';
import { apiDelete, apiGet, apiPost, apiPut } from '../../../lib/api';
import { useAuth } from '../../../lib/auth-context';
import type { AuthPermissions } from '../../../lib/types';
import styles from './page.module.css';

interface ManagedUser {
  id: number;
  full_name: string;
  email: string;
  role: string;
  is_root: boolean;
  is_active: boolean;
  created_at: string;
  permissions: AuthPermissions;
}

interface UserFormState {
  id?: number;
  full_name: string;
  email: string;
  role: string;
  password: string;
  is_root: boolean;
  is_active: boolean;
  permissions: AuthPermissions;
}

const EMPTY_FORM: UserFormState = {
  full_name: '',
  email: '',
  role: 'staff',
  password: '',
  is_root: false,
  is_active: true,
  permissions: {
    dashboard: true,
    properties: false,
    tenants: false,
    finance: false,
    documents: false,
    settings: false,
  },
};

const PERMISSION_FIELDS: Array<keyof AuthPermissions> = ['dashboard', 'properties', 'tenants', 'finance', 'documents', 'settings'];

export default function SettingsPage() {
  const { user } = useAuth();
  const [users, setUsers] = React.useState<ManagedUser[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [form, setForm] = React.useState<UserFormState>(EMPTY_FORM);
  const [showModal, setShowModal] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const isRoot = Boolean(user?.is_root);

  const loadUsers = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiGet<{ items: ManagedUser[] }>('/api/users');
      setUsers(data.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load users.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setShowModal(true);
  };

  const openEdit = (managedUser: ManagedUser) => {
    setForm({
      id: managedUser.id,
      full_name: managedUser.full_name,
      email: managedUser.email,
      role: managedUser.role,
      password: '',
      is_root: managedUser.is_root,
      is_active: managedUser.is_active,
      permissions: { ...managedUser.permissions },
    });
    setShowModal(true);
  };

  const onSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');

    try {
      if (!form.full_name.trim() || !form.email.trim()) {
        throw new Error('Name and email are required.');
      }
      if (!form.id && form.password.trim().length < 8) {
        throw new Error('Password must have at least 8 characters.');
      }

      const payload = {
        full_name: form.full_name.trim(),
        email: form.email.trim(),
        role: form.role.trim() || 'staff',
        password: form.password.trim(),
        is_root: form.is_root,
        is_active: form.is_active,
        permissions: form.permissions,
      };

      if (form.id) {
        await apiPut(`/api/users/${form.id}`, payload);
      } else {
        await apiPost('/api/users', payload);
      }

      setShowModal(false);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save user.');
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (target: ManagedUser) => {
    if (!window.confirm(`Deactivate ${target.full_name}?`)) return;
    try {
      await apiDelete(`/api/users/${target.id}`);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to deactivate user.');
    }
  };

  if (!user?.permissions?.settings && !user?.is_root) {
    return <div className={styles.container}>You do not have access to settings.</div>;
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div>
          <h2>User Access Control</h2>
          <p>Create users and define which modules each account can access.</p>
        </div>
        {isRoot && (
          <Button variant="primary" onClick={openCreate}>
            <Plus size={18} />
            New User
          </Button>
        )}
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <Card className={styles.card}>
        {loading ? (
          <div className={styles.loading}>Loading users...</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Permissions</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((item) => (
                  <tr key={item.id}>
                    <td>{item.full_name}</td>
                    <td>{item.email}</td>
                    <td>{item.is_root ? 'Root' : item.role}</td>
                    <td>{item.is_active ? 'Active' : 'Inactive'}</td>
                    <td>
                      <div className={styles.permissionsSummary}>
                        {PERMISSION_FIELDS.filter((field) => item.permissions[field]).join(', ') || '-'}
                      </div>
                    </td>
                    <td>
                      {isRoot && (
                        <div className={styles.actions}>
                          <button className={styles.iconBtn} onClick={() => openEdit(item)}>
                            <Pencil size={16} />
                          </button>
                          {!item.is_root && (
                            <button className={`${styles.iconBtn} ${styles.danger}`} onClick={() => void deactivate(item)}>
                              <UserX size={16} />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={form.id ? 'Edit User' : 'Create User'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowModal(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="user-form" disabled={saving}>
              {saving ? 'Saving...' : form.id ? 'Save User' : 'Create User'}
            </Button>
          </>
        }
      >
        <form id="user-form" className={styles.form} onSubmit={onSave}>
          <div className={styles.grid}>
            <label className={styles.field}>
              <span>Full Name</span>
              <input
                value={form.full_name}
                onChange={(e) => setForm((prev) => ({ ...prev, full_name: e.target.value }))}
                required
              />
            </label>

            <label className={styles.field}>
              <span>Email</span>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
                required
              />
            </label>

            <label className={styles.field}>
              <span>Role</span>
              <input value={form.role} onChange={(e) => setForm((prev) => ({ ...prev, role: e.target.value }))} />
            </label>

            <label className={styles.field}>
              <span>{form.id ? 'New Password (optional)' : 'Password'}</span>
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                placeholder={form.id ? 'Leave empty to keep current' : 'At least 8 characters'}
              />
            </label>

            <label className={styles.switchRow}>
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm((prev) => ({ ...prev, is_active: e.target.checked }))}
              />
              <span>Active user</span>
            </label>

            <label className={styles.switchRow}>
              <input
                type="checkbox"
                checked={form.is_root}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    is_root: e.target.checked,
                    permissions: e.target.checked
                      ? {
                          dashboard: true,
                          properties: true,
                          tenants: true,
                          finance: true,
                          documents: true,
                          settings: true,
                        }
                      : prev.permissions,
                  }))
                }
              />
              <span>Root account (full access)</span>
            </label>

            {!form.is_root && (
              <div className={styles.permissionsBlock}>
                <span>Module Access</span>
                <div className={styles.permissionsGrid}>
                  {PERMISSION_FIELDS.map((field) => (
                    <label key={field} className={styles.switchRow}>
                      <input
                        type="checkbox"
                        checked={form.permissions[field]}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            permissions: {
                              ...prev.permissions,
                              [field]: e.target.checked,
                            },
                          }))
                        }
                      />
                      <span>{field}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        </form>
      </Modal>
    </div>
  );
}
