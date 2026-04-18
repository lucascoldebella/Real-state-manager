'use client';
/* eslint-disable @next/next/no-img-element */

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search, Plus, Pencil, Trash2, UserRoundPlus, Mail, Phone, FileText, CheckCircle2, X } from 'lucide-react';
import { Card } from '../../../components/ui/Card/Card';
import { Badge } from '../../../components/ui/Badge/Badge';
import { Button } from '../../../components/ui/Button/Button';
import { Modal } from '../../../components/ui/Modal/Modal';
import { TenantFormModal, type TenantPrefillData } from '../../../components/tenants/TenantFormModal';
import { apiDelete, apiGet } from '../../../lib/api';
import type { PreRegistration, Tenant } from '../../../lib/types';
import styles from './page.module.css';

const formatMoney = (value: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value || 0);

const formatDate = (value: string): string => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
};

export default function TenantsPage() {
  const router = useRouter();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [preRegistrations, setPreRegistrations] = useState<PreRegistration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);
  const [viewingTenant, setViewingTenant] = useState<Tenant | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deletePreId, setDeletePreId] = useState<number | null>(null);
  const [prefillData, setPrefillData] = useState<TenantPrefillData | null>(null);
  const [newlyCreatedId, setNewlyCreatedId] = useState<number | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [tenantData, preData] = await Promise.all([
        apiGet<{ items: Tenant[] }>('/api/tenants'),
        apiGet<{ items: PreRegistration[] }>('/api/pre-registrations'),
      ]);
      setTenants(tenantData.items || []);
      setPreRegistrations(preData.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load tenants.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onRefresh = () => void load();
    window.addEventListener('oc:data-refresh', onRefresh);
    return () => {
      window.removeEventListener('oc:data-refresh', onRefresh);
    };
  }, [load]);

  const filteredTenants = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tenants;
    return tenants.filter((tenant) => {
      const haystack = [tenant.full_name, tenant.email, tenant.phone, tenant.cpf, tenant.unit_number].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [query, tenants]);

  const handleDelete = async (tenantId: number) => {
    if (!window.confirm('Move tenant to inactive list?')) return;

    setDeletingId(tenantId);
    try {
      await apiDelete(`/api/tenants/${tenantId}`);
      window.dispatchEvent(new CustomEvent('oc:data-refresh'));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete tenant.');
    } finally {
      setDeletingId(null);
    }
  };

  const handleDeletePre = async (id: number) => {
    if (!window.confirm('Delete this pre-register entry?')) return;

    setDeletePreId(id);
    try {
      await apiDelete(`/api/pre-registrations/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete pre-register entry.');
    } finally {
      setDeletePreId(null);
    }
  };

  const applyPreRegistration = (entry: PreRegistration) => {
    setPrefillData({
      full_name: entry.full_name,
      cpf: entry.cpf,
      rg: entry.rg,
      civil_state: entry.civil_state,
      occupation: entry.occupation,
      reference_address: entry.reference_address,
      phone: entry.phone,
      email: entry.email,
      due_day: entry.due_day,
      contract_months: entry.contract_months,
      document_front_image: entry.doc_front_image,
      document_back_image: entry.doc_back_image,
    });
    setShowCreate(true);
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <h2>Tenants</h2>
          <p>Manage tenant lifecycle, documents, and unit assignments.</p>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.searchContainer}>
            <Search size={18} className={styles.searchIcon} />
            <input
              type="text"
              placeholder="Search tenants..."
              className={styles.searchInput}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Button
            variant="primary"
            onClick={() => {
              setPrefillData(null);
              setShowCreate(true);
            }}
          >
            <Plus size={18} />
            Add Tenant
          </Button>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <Card className={styles.preCard}>
        <div className={styles.preHeader}>
          <div>
            <h3>Pre-Register Queue</h3>
            <p>New guided submissions from tenants waiting for admin completion.</p>
          </div>
          <Link href="/pre-register" className={styles.preLink} target="_blank">
            Open public pre-register page
          </Link>
        </div>
        <div className={styles.preList}>
          {preRegistrations.length === 0 && <div className={styles.emptyPre}>No pending pre-register entries.</div>}
          {preRegistrations.map((entry) => (
            <div key={entry.id} className={styles.preItem}>
              <div>
                <strong>{entry.full_name}</strong>
                <span>CPF {entry.cpf}</span>
                <span>Email {entry.email || '-'}</span>
              </div>
              <div className={styles.preActions}>
                <button className={styles.smallBtn} onClick={() => applyPreRegistration(entry)}>
                  <UserRoundPlus size={14} />
                  Use in new tenant
                </button>
                <button className={`${styles.smallBtn} ${styles.dangerBtn}`} disabled={deletePreId === entry.id} onClick={() => void handleDeletePre(entry.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className={styles.tableCard}>
        {loading ? (
          <div className={styles.loadingState}>Loading tenants...</div>
        ) : (
          <>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Tenant</th>
                    <th>Unit</th>
                    <th>Rent / Due</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTenants.map((tenant) => (
                    <tr key={tenant.id} onClick={() => setViewingTenant(tenant)}>
                      <td>
                        <div className={styles.tenantInfo}>
                          <div className={styles.avatar}>
                            {tenant.profile_photo ? <img src={tenant.profile_photo} alt={tenant.full_name} /> : tenant.full_name.charAt(0)}
                          </div>
                          <div className={styles.tenantBlock}>
                            <span className={styles.tenantName}>{tenant.full_name}</span>
                            <span className={styles.subText}>CPF {tenant.cpf}</span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={styles.unitBadge}>{tenant.unit_number || 'Unassigned'}</span>
                      </td>
                      <td>
                        <div className={styles.leaseDates}>
                          <span>{formatMoney(tenant.rent_amount)}</span>
                          <span className={styles.subText}>Day {tenant.due_day}</span>
                        </div>
                      </td>
                      <td>
                        <Badge variant={tenant.active ? 'success' : 'warning'}>{tenant.active ? 'Active' : 'Inactive'}</Badge>
                      </td>
                      <td className={styles.actionsCell} onClick={(event) => event.stopPropagation()}>
                        <div className={styles.actionGroup}>
                          <button className={styles.actionBtn} onClick={() => setEditingTenant(tenant)}>
                            <Pencil size={16} />
                          </button>
                          <button className={`${styles.actionBtn} ${styles.dangerBtn}`} onClick={() => void handleDelete(tenant.id)} disabled={deletingId === tenant.id}>
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={styles.mobileList}>
              {filteredTenants.map((tenant) => (
                <button key={tenant.id} className={styles.mobileCard} onClick={() => setViewingTenant(tenant)}>
                  <div className={styles.mobileTop}>
                    <div className={styles.tenantInfo}>
                      <div className={styles.avatar}>
                        {tenant.profile_photo ? <img src={tenant.profile_photo} alt={tenant.full_name} /> : tenant.full_name.charAt(0)}
                      </div>
                      <div className={styles.tenantBlock}>
                        <span className={styles.tenantName}>{tenant.full_name}</span>
                        <span className={styles.subText}>{tenant.unit_number || 'Unassigned'}</span>
                      </div>
                    </div>
                    <Badge variant={tenant.active ? 'success' : 'warning'}>{tenant.active ? 'Active' : 'Inactive'}</Badge>
                  </div>
                  <div className={styles.mobileMeta}>
                    <span>{formatMoney(tenant.rent_amount)}</span>
                    <span>Day {tenant.due_day}</span>
                  </div>
                </button>
              ))}
            </div>

            {filteredTenants.length === 0 && <div className={styles.loadingState}>No tenants found for this search.</div>}
          </>
        )}
      </Card>

      {/* "Gerar Contrato" banner after tenant creation */}
      {newlyCreatedId !== null && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: '#0f172a', color: '#e2e8f0', borderRadius: 12,
          padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 14,
          boxShadow: '0 20px 50px rgba(0,0,0,0.35)', zIndex: 9999,
          fontFamily: 'var(--font-sans)', fontSize: '0.875rem', fontWeight: 500,
          maxWidth: 520, width: 'calc(100vw - 48px)',
        }}>
          <CheckCircle2 size={20} style={{ color: '#4ade80', flexShrink: 0 }} />
          <span style={{ flex: 1 }}>Inquilino criado com sucesso! Deseja gerar o contrato agora?</span>
          <button
            onClick={() => {
              const id = newlyCreatedId;
              setNewlyCreatedId(null);
              router.push(`/documents/contract?tenantId=${id}`);
            }}
            style={{
              background: '#6366f1', color: 'white', border: 'none', borderRadius: 8,
              padding: '8px 14px', fontWeight: 700, fontSize: '0.8125rem', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
              fontFamily: 'var(--font-sans)',
            }}
          >
            <FileText size={14} /> Gerar Contrato
          </button>
          <button
            onClick={() => setNewlyCreatedId(null)}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4 }}
            aria-label="Fechar"
          >
            <X size={16} />
          </button>
        </div>
      )}

      <TenantFormModal
        isOpen={showCreate}
        mode="create"
        prefillData={prefillData}
        onClose={() => {
          setShowCreate(false);
          setPrefillData(null);
        }}
        onSaved={(newId) => {
          void load();
          if (newId) setNewlyCreatedId(newId);
        }}
      />
      <TenantFormModal
        isOpen={Boolean(editingTenant)}
        mode="edit"
        initialTenant={editingTenant}
        onClose={() => setEditingTenant(null)}
        onSaved={() => void load()}
      />

      <Modal isOpen={Boolean(viewingTenant)} onClose={() => setViewingTenant(null)} title={viewingTenant?.full_name || 'Tenant'}>
        {viewingTenant && (
          <div className={styles.details}>
            <div className={styles.detailProfile}>
              <div className={styles.detailAvatar}>
                {viewingTenant.profile_photo ? (
                  <img src={viewingTenant.profile_photo} alt={viewingTenant.full_name} />
                ) : (
                  viewingTenant.full_name.charAt(0)
                )}
              </div>
              <div>
                <strong>{viewingTenant.full_name}</strong>
                <span>Unit {viewingTenant.unit_number || '-'}</span>
              </div>
            </div>

            <div className={styles.detailGrid}>
              <div>
                <span>CPF</span>
                <strong>{viewingTenant.cpf || '-'}</strong>
              </div>
              <div>
                <span>RG</span>
                <strong>{viewingTenant.rg || '-'}</strong>
              </div>
              <div>
                <span>Phone</span>
                <strong><Phone size={14} /> {viewingTenant.phone || '-'}</strong>
              </div>
              <div>
                <span>Email</span>
                <strong><Mail size={14} /> {viewingTenant.email || '-'}</strong>
              </div>
              <div>
                <span>Civil State</span>
                <strong>{viewingTenant.civil_state || '-'}</strong>
              </div>
              <div>
                <span>Occupation</span>
                <strong>{viewingTenant.occupation || '-'}</strong>
              </div>
              <div>
                <span>Contract</span>
                <strong>{formatDate(viewingTenant.contract_start)} to {formatDate(viewingTenant.contract_end)}</strong>
              </div>
              <div>
                <span>Rent</span>
                <strong>{formatMoney(viewingTenant.rent_amount)} (day {viewingTenant.due_day})</strong>
              </div>
            </div>

            <div>
              <span className={styles.notesLabel}>Reference Address</span>
              <p className={styles.notesText}>{viewingTenant.reference_address || '-'}</p>
            </div>
            <div>
              <span className={styles.notesLabel}>Notes</span>
              <p className={styles.notesText}>{viewingTenant.notes || '-'}</p>
            </div>

            <div style={{ marginTop: 4 }}>
              <Link
                href={`/documents/contract?tenantId=${viewingTenant.id}`}
                className={styles.smallBtn}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', textDecoration: 'none', fontWeight: 600, background: 'var(--primary)', color: 'white', border: '1px solid var(--primary)', borderRadius: 'var(--radius-md)' }}
              >
                <FileText size={15} />
                Ver Contrato
              </Link>
            </div>

            <div className={styles.docsWrap}>
              <div>
                <span className={styles.notesLabel}>Document Front</span>
                {viewingTenant.document_front_image ? <img src={viewingTenant.document_front_image} alt="Document front" /> : <p>-</p>}
              </div>
              <div>
                <span className={styles.notesLabel}>Document Back</span>
                {viewingTenant.document_back_image ? <img src={viewingTenant.document_back_image} alt="Document back" /> : <p>-</p>}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
