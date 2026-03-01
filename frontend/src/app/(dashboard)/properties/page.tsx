'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Wallet, History, ClipboardList, BellRing, FileDown } from 'lucide-react';
import { Card } from '../../../components/ui/Card/Card';
import { Button } from '../../../components/ui/Button/Button';
import { Modal } from '../../../components/ui/Modal/Modal';
import { UnitGrid } from '../../../components/dashboard/UnitGrid/UnitGrid';
import { apiGet, apiPost, apiPut, downloadWithAuth } from '../../../lib/api';
import type { DashboardGridItem, DocumentTemplate, Tenant, UnitDetail, UnitItem } from '../../../lib/types';
import styles from './page.module.css';

interface UnitFormState {
  id?: number;
  unit_number: string;
  status: 'occupied' | 'vacant';
  base_rent: string;
  tenant_id: string;
  is_active: boolean;
  inactive_reason: string;
  available_from: string;
}

interface HistoryRow {
  month: string;
  tenant_id: number;
  tenant_name: string;
  amount: number;
  due_date: string;
  status: string;
  paid_at: string;
  late_fee: number;
  hasCharge: boolean;
}

const EMPTY_FORM: UnitFormState = {
  unit_number: '',
  status: 'vacant',
  base_rent: '',
  tenant_id: '',
  is_active: true,
  inactive_reason: '',
  available_from: '',
};

const DUE_NOTE_FALLBACK =
  'Hello {{tenant_name}}, this is a reminder that rent for unit {{unit_number}} is due on {{due_date}}. Amount: {{rent_value}}.';
const OVERDUE_NOTE_FALLBACK =
  'Hello {{tenant_name}}, rent for unit {{unit_number}} is overdue since {{due_date}}. Outstanding amount: {{rent_value}}. Please contact us.';

const money = (value: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value || 0);

const formatDate = (value: string): string => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
};

const formatMonthLabel = (month: string): string => {
  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  const date = new Date(year, monthIndex, 1);
  if (Number.isNaN(date.getTime())) return month;
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
};

const getMonthKey = (offset: number): string => {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() - offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

const clampDueDay = (value: number): number => {
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(28, Math.round(value)));
};

function fillTemplate(template: string, values: Record<string, string>): string {
  let text = template;
  Object.entries(values).forEach(([key, value]) => {
    text = text.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), value);
  });
  return text;
}

async function copyText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

export default function PropertiesPage() {
  const [units, setUnits] = useState<UnitItem[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showEditor, setShowEditor] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<UnitFormState>(EMPTY_FORM);

  const [selectedUnitCard, setSelectedUnitCard] = useState<DashboardGridItem | null>(null);
  const [unitDetail, setUnitDetail] = useState<UnitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedMonths, setSelectedMonths] = useState<Record<string, boolean>>({});
  const [actionMessage, setActionMessage] = useState('');
  const [payingCurrent, setPayingCurrent] = useState(false);
  const [markingPast, setMarkingPast] = useState(false);
  const [downloadingEviction, setDownloadingEviction] = useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [unitsResponse, tenantsResponse, templatesResponse] = await Promise.all([
        apiGet<{ items: UnitItem[] }>('/api/units'),
        apiGet<{ items: Tenant[] }>('/api/tenants'),
        apiGet<{ items: DocumentTemplate[] }>('/api/document-templates'),
      ]);
      setUnits(unitsResponse.items || []);
      setTenants((tenantsResponse.items || []).filter((tenant) => tenant.active));
      setTemplates(templatesResponse.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load units.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadUnitDetail = React.useCallback(async (unitId: number) => {
    setDetailLoading(true);
    try {
      const detail = await apiGet<UnitDetail>(`/api/units/${unitId}`);
      setUnitDetail(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load unit details.');
    } finally {
      setDetailLoading(false);
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

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setShowEditor(true);
  };

  const openEdit = (unit: UnitItem) => {
    setForm({
      id: unit.id,
      unit_number: unit.unit_number,
      status: unit.status,
      base_rent: String(unit.base_rent || ''),
      tenant_id: unit.tenant_id > 0 ? String(unit.tenant_id) : '',
      is_active: unit.is_active,
      inactive_reason: unit.inactive_reason || '',
      available_from: unit.available_from || '',
    });
    setShowEditor(true);
  };

  const openUnitOverview = async (unit: DashboardGridItem) => {
    setSelectedUnitCard(unit);
    setActionMessage('');
    setShowHistory(false);
    setSelectedMonths({});
    await loadUnitDetail(unit.id);
  };

  const closeUnitOverview = () => {
    setSelectedUnitCard(null);
    setUnitDetail(null);
    setShowHistory(false);
    setSelectedMonths({});
    setActionMessage('');
  };

  const onSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = {
        unit_number: form.unit_number.trim(),
        status: form.status,
        base_rent: Number(form.base_rent || 0),
        tenant_id: form.tenant_id ? Number(form.tenant_id) : 0,
        is_active: form.is_active,
        inactive_reason: form.inactive_reason.trim(),
        available_from: form.available_from || '',
      };

      if (!payload.unit_number) {
        throw new Error('Unit number is required.');
      }

      if (form.id) {
        await apiPut(`/api/units/${form.id}`, payload);
      } else {
        await apiPost('/api/units', payload);
      }

      window.dispatchEvent(new CustomEvent('oc:data-refresh'));
      setShowEditor(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save unit.');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (unit: UnitItem) => {
    const nextActive = !unit.is_active;
    try {
      await apiPut(`/api/units/${unit.id}`, {
        is_active: nextActive,
        inactive_reason: nextActive ? '' : unit.inactive_reason || 'In reform',
        available_from: nextActive ? '' : unit.available_from || '',
      });
      window.dispatchEvent(new CustomEvent('oc:data-refresh'));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to toggle unit state.');
    }
  };

  const availableTenants = useMemo(() => {
    const editingUnitId = form.id;
    return tenants.filter((tenant) => {
      if (!tenant.unit_id) return true;
      if (!editingUnitId) return false;
      const editingUnit = units.find((unit) => unit.id === editingUnitId);
      return editingUnit ? tenant.unit_id === editingUnit.id : false;
    });
  }, [form.id, tenants, units]);

  const gridItems: DashboardGridItem[] = useMemo(
    () =>
      units.map((unit) => ({
        id: unit.id,
        unit_number: unit.unit_number,
        tenant_name: unit.tenant_name,
        status: unit.payment_status,
        is_active: unit.is_active,
        inactive_reason: unit.inactive_reason,
        available_from: unit.available_from,
      })),
    [units],
  );

  const historyRows = useMemo<HistoryRow[]>(() => {
    if (!unitDetail) return [];
    const map = new Map(unitDetail.payment_history.map((entry) => [entry.month, entry]));
    const rows: HistoryRow[] = [];

    for (let offset = 0; offset < 12; offset += 1) {
      const month = getMonthKey(offset);
      const charge = map.get(month);
      if (charge) {
        rows.push({
          month,
          tenant_id: charge.tenant_id,
          tenant_name: charge.tenant_name || '-',
          amount: charge.amount,
          due_date: charge.due_date,
          status: charge.status,
          paid_at: charge.paid_at,
          late_fee: charge.late_fee,
          hasCharge: true,
        });
      } else {
        rows.push({
          month,
          tenant_id: 0,
          tenant_name: '-',
          amount: 0,
          due_date: '',
          status: 'no_charge',
          paid_at: '',
          late_fee: 0,
          hasCharge: false,
        });
      }
    }
    return rows;
  }, [unitDetail]);

  const currentMonth = getMonthKey(0);
  const currentRow = historyRows.find((row) => row.month === currentMonth);

  const currentDueDate = useMemo(() => {
    if (currentRow?.due_date) return currentRow.due_date;
    if (!unitDetail) return '';
    const dueDay = String(clampDueDay(unitDetail.due_day)).padStart(2, '0');
    return `${currentMonth}-${dueDay}`;
  }, [currentMonth, currentRow?.due_date, unitDetail]);

  const noteTemplateValues = useMemo(() => {
    if (!unitDetail || !selectedUnitCard) return null;
    return {
      tenant_name: unitDetail.tenant_name || 'Tenant',
      cpf: unitDetail.tenant_cpf || '',
      unit_number: selectedUnitCard.unit_number,
      rent_value: money(unitDetail.tenant_rent || unitDetail.base_rent),
      due_date: currentDueDate || '-',
      month: currentMonth,
    };
  }, [currentDueDate, currentMonth, selectedUnitCard, unitDetail]);

  const dueNoteTemplate = templates.find((template) => template.document_type === 'due_note');
  const overdueNoteTemplate = templates.find((template) => template.document_type === 'overdue_note');
  const evictionTemplate = templates.find((template) => template.document_type === 'eviction_notice');

  const registerCurrentMonthPayment = async () => {
    if (!unitDetail) return;
    if (unitDetail.tenant_id <= 0) {
      setActionMessage('No active tenant in this unit.');
      return;
    }

    setPayingCurrent(true);
    setActionMessage('');
    try {
      await apiPost('/api/payments', {
        tenant_id: unitDetail.tenant_id,
        month: currentMonth,
        amount: unitDetail.tenant_rent > 0 ? unitDetail.tenant_rent : unitDetail.base_rent,
        payment_method: 'manual',
        notes: 'Registered from property control center',
      });
      await load();
      await loadUnitDetail(unitDetail.id);
      setActionMessage(`Payment registered for ${formatMonthLabel(currentMonth)}.`);
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : 'Unable to register payment.');
    } finally {
      setPayingCurrent(false);
    }
  };

  const toggleMonthSelection = (month: string, checked: boolean) => {
    setSelectedMonths((prev) => ({ ...prev, [month]: checked }));
  };

  const settleSelectedPastMonths = async () => {
    if (!unitDetail) return;
    const rows = historyRows.filter(
      (row) => selectedMonths[row.month] && row.hasCharge && row.status !== 'paid' && row.tenant_id > 0 && row.amount > 0,
    );
    if (rows.length === 0) {
      setActionMessage('Select at least one unpaid month with an assigned tenant.');
      return;
    }

    setMarkingPast(true);
    setActionMessage('');
    try {
      for (const row of rows) {
        await apiPost('/api/payments', {
          tenant_id: row.tenant_id,
          month: row.month,
          amount: row.amount,
          payment_method: 'manual',
          notes: 'Settled from unit history',
        });
      }
      setSelectedMonths({});
      await load();
      await loadUnitDetail(unitDetail.id);
      setActionMessage(`Marked ${rows.length} month(s) as paid.`);
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : 'Unable to settle selected months.');
    } finally {
      setMarkingPast(false);
    }
  };

  const copyDueNote = async () => {
    if (!noteTemplateValues) return;
    try {
      const body = dueNoteTemplate?.template_body || DUE_NOTE_FALLBACK;
      await copyText(fillTemplate(body, noteTemplateValues));
      setActionMessage('Due date note copied to clipboard.');
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : 'Unable to copy note.');
    }
  };

  const copyOverdueNote = async () => {
    if (!noteTemplateValues) return;
    try {
      const body = overdueNoteTemplate?.template_body || OVERDUE_NOTE_FALLBACK;
      await copyText(fillTemplate(body, noteTemplateValues));
      setActionMessage('Overdue notification copied to clipboard.');
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : 'Unable to copy notification.');
    }
  };

  const downloadEvictionNote = async () => {
    if (!unitDetail) return;
    if (!evictionTemplate) {
      setActionMessage('No eviction template found. Add or edit it in Document Center.');
      return;
    }
    if (unitDetail.tenant_id <= 0) {
      setActionMessage('This unit has no active tenant.');
      return;
    }

    setDownloadingEviction(true);
    setActionMessage('');
    try {
      const response = await apiPost<{ document_id: number; download_url: string }>('/api/documents/generate', {
        template_id: evictionTemplate.id,
        tenant_id: unitDetail.tenant_id,
      });
      await downloadWithAuth(response.download_url, `eviction-note-unit-${unitDetail.unit_number}.pdf`);
      setActionMessage('Eviction notice PDF generated and downloaded.');
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : 'Unable to generate eviction note PDF.');
    } finally {
      setDownloadingEviction(false);
    }
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <h2>Properties</h2>
          <p>Manage units, disable/enable availability, and keep tenant assignments synchronized.</p>
        </div>
        <div className={styles.actions}>
          <Button variant="primary" onClick={openCreate}>
            <Plus size={18} />
            Create Unit
          </Button>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <UnitGrid
        items={gridItems}
        hideDisabled
        subtitle="Active occupancy and payment status across enabled units."
        onUnitClick={(unit) => void openUnitOverview(unit)}
      />

      <Card className={styles.tableCard}>
        {loading ? (
          <div className={styles.loading}>Loading units...</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Unit</th>
                <th>Occupancy</th>
                <th>Payment</th>
                <th>Tenant</th>
                <th>Rent</th>
                <th>Availability</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {units.map((unit) => (
                <tr key={unit.id}>
                  <td>{unit.unit_number}</td>
                  <td>
                    <span className={styles.pill}>{unit.status}</span>
                  </td>
                  <td>
                    <span className={styles.pill}>{unit.payment_status}</span>
                  </td>
                  <td>{unit.tenant_name || '-'}</td>
                  <td>{money(unit.base_rent)}</td>
                  <td>{unit.is_active ? 'Active' : `Disabled${unit.available_from ? ` until ${unit.available_from}` : ''}`}</td>
                  <td>
                    <div className={styles.actionRow}>
                      <button className={styles.smallBtn} onClick={() => openEdit(unit)}>
                        Edit
                      </button>
                      <button
                        className={`${styles.smallBtn} ${!unit.is_active ? '' : styles.dangerBtn}`}
                        onClick={() => void toggleActive(unit)}
                      >
                        {unit.is_active ? 'Disable' : 'Enable'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Modal
        isOpen={showEditor}
        onClose={() => setShowEditor(false)}
        title={form.id ? `Edit Unit ${form.unit_number}` : 'Create Unit'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowEditor(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="unit-editor-form" disabled={saving}>
              {saving ? 'Saving...' : form.id ? 'Save Unit' : 'Create Unit'}
            </Button>
          </>
        }
      >
        <form id="unit-editor-form" className={styles.form} onSubmit={onSave}>
          <div className={styles.grid}>
            <div className={styles.field}>
              <label>Unit Number</label>
              <input value={form.unit_number} onChange={(e) => setForm((s) => ({ ...s, unit_number: e.target.value }))} />
            </div>
            <div className={styles.field}>
              <label>Base Rent</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.base_rent}
                onChange={(e) => setForm((s) => ({ ...s, base_rent: e.target.value }))}
              />
            </div>

            <div className={styles.field}>
              <label>Occupancy Status</label>
              <select value={form.status} onChange={(e) => setForm((s) => ({ ...s, status: e.target.value as 'occupied' | 'vacant' }))}>
                <option value="vacant">Vacant</option>
                <option value="occupied">Occupied</option>
              </select>
            </div>

            <div className={styles.field}>
              <label>Assigned Tenant</label>
              <select value={form.tenant_id} onChange={(e) => setForm((s) => ({ ...s, tenant_id: e.target.value }))} disabled={!form.is_active}>
                <option value="">No tenant</option>
                {availableTenants.map((tenant) => (
                  <option key={tenant.id} value={String(tenant.id)}>
                    {tenant.full_name} ({tenant.unit_number || 'unassigned'})
                  </option>
                ))}
              </select>
            </div>

            <div className={`${styles.field} ${styles.span2}`}>
              <div className={styles.switchRow}>
                <input
                  id="active-toggle"
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm((s) => ({ ...s, is_active: e.target.checked }))}
                />
                <label htmlFor="active-toggle">Unit is active (disable for reform/unavailable periods)</label>
              </div>
            </div>

            {!form.is_active && (
              <>
                <div className={styles.field}>
                  <label>Inactive Reason</label>
                  <input
                    value={form.inactive_reason}
                    onChange={(e) => setForm((s) => ({ ...s, inactive_reason: e.target.value }))}
                    placeholder="In reform"
                  />
                </div>
                <div className={styles.field}>
                  <label>Expected Available Date</label>
                  <input type="date" value={form.available_from} onChange={(e) => setForm((s) => ({ ...s, available_from: e.target.value }))} />
                </div>
              </>
            )}
          </div>
        </form>
      </Modal>

      <Modal isOpen={Boolean(selectedUnitCard)} onClose={closeUnitOverview} title={selectedUnitCard ? `Unit ${selectedUnitCard.unit_number}` : 'Unit'} size="lg">
        {detailLoading && <div className={styles.loadingInline}>Loading unit overview...</div>}
        {!detailLoading && unitDetail && selectedUnitCard && (
          <div className={styles.unitOverview}>
            <div className={styles.overviewTop}>
              <div>
                <h3>{unitDetail.tenant_name || 'No active tenant'}</h3>
                <p>{unitDetail.is_active ? 'Unit enabled' : `Disabled: ${unitDetail.inactive_reason || 'Unavailable'}`}</p>
              </div>
              <span className={styles.statusBadge}>{selectedUnitCard.status.replace('_', ' ')}</span>
            </div>

            <div className={styles.overviewStats}>
              <div className={styles.infoCard}>
                <span>Monthly Rent</span>
                <strong>{money(unitDetail.tenant_rent || unitDetail.base_rent)}</strong>
              </div>
              <div className={styles.infoCard}>
                <span>Due Day</span>
                <strong>Day {clampDueDay(unitDetail.due_day)}</strong>
              </div>
              <div className={styles.infoCard}>
                <span>Current Due Date</span>
                <strong>{formatDate(currentDueDate)}</strong>
              </div>
              <div className={styles.infoCard}>
                <span>Availability</span>
                <strong>{unitDetail.is_active ? 'Enabled' : 'Disabled'}</strong>
              </div>
            </div>

            <div className={styles.overviewActions}>
              <button className={styles.toolBtn} onClick={() => void registerCurrentMonthPayment()} disabled={payingCurrent || unitDetail.tenant_id <= 0}>
                <Wallet size={16} />
                {payingCurrent ? 'Registering...' : 'Register current month payment'}
              </button>
              <button className={styles.toolBtn} onClick={() => setShowHistory(true)}>
                <History size={16} />
                Open 12-month history
              </button>
              <button className={styles.toolBtn} onClick={() => void copyDueNote()}>
                <ClipboardList size={16} />
                Copy due date note
              </button>
              <button className={styles.toolBtn} onClick={() => void copyOverdueNote()}>
                <BellRing size={16} />
                Copy overdue notification
              </button>
              <button className={styles.toolBtn} onClick={() => void downloadEvictionNote()} disabled={downloadingEviction}>
                <FileDown size={16} />
                {downloadingEviction ? 'Preparing PDF...' : 'Eviction note PDF download'}
              </button>
            </div>

            {actionMessage && <div className={styles.actionMessage}>{actionMessage}</div>}
          </div>
        )}
      </Modal>

      <Modal
        isOpen={showHistory}
        onClose={() => setShowHistory(false)}
        title={selectedUnitCard ? `Unit ${selectedUnitCard.unit_number} • Latest 12 months` : 'History'}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowHistory(false)}>
              Close
            </Button>
            <Button variant="primary" onClick={() => void settleSelectedPastMonths()} disabled={markingPast}>
              {markingPast ? 'Saving...' : 'Set selected months as paid'}
            </Button>
          </>
        }
      >
        <div className={styles.historyList}>
          {historyRows.map((row) => {
            const canSettle = row.hasCharge && row.status !== 'paid' && row.tenant_id > 0 && row.amount > 0;
            return (
              <div key={row.month} className={styles.historyRow}>
                <div className={styles.historyMain}>
                  <strong>{formatMonthLabel(row.month)}</strong>
                  <span>{row.tenant_name || '-'}</span>
                  <span>{row.amount > 0 ? money(row.amount) : '-'}</span>
                </div>
                <div className={styles.historyMeta}>
                  <span className={`${styles.historyStatus} ${row.status === 'paid' ? styles.statusPaid : row.status === 'overdue' ? styles.statusOverdue : styles.statusPending}`}>
                    {row.status === 'no_charge' ? 'No charge' : row.status}
                  </span>
                  <span>{row.due_date ? `Due ${formatDate(row.due_date)}` : '-'}</span>
                  {canSettle ? (
                    <label className={styles.historyCheckbox}>
                      <input
                        type="checkbox"
                        checked={Boolean(selectedMonths[row.month])}
                        onChange={(e) => toggleMonthSelection(row.month, e.target.checked)}
                      />
                      Mark paid
                    </label>
                  ) : (
                    <span className={styles.dimmed}>-</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Modal>
    </div>
  );
}
