'use client';
/* eslint-disable @next/next/no-img-element */

import React, { useEffect, useMemo, useState } from 'react';
import Cropper, { type Area, type Point } from 'react-easy-crop';
import { Upload, Image as ImageIcon } from 'lucide-react';
import { Modal } from '../ui/Modal/Modal';
import { Button } from '../ui/Button/Button';
import { apiGet, apiPost, apiPut } from '../../lib/api';
import type { Tenant, UnitItem } from '../../lib/types';
import styles from './TenantFormModal.module.css';

interface TenantFormValues {
  full_name: string;
  cpf: string;
  rg: string;
  civil_state: string;
  occupation: string;
  reference_address: string;
  phone: string;
  email: string;
  unit_id: string;
  rent_amount: string;
  due_day: string;
  contract_start: string;
  contract_end: string;
  notes: string;
  profile_photo: string;
  document_front_image: string;
  document_back_image: string;
}

export interface TenantPrefillData {
  full_name?: string;
  cpf?: string;
  rg?: string;
  civil_state?: string;
  occupation?: string;
  reference_address?: string;
  phone?: string;
  email?: string;
  due_day?: number;
  contract_months?: number;
  document_front_image?: string;
  document_back_image?: string;
}

interface TenantFormModalProps {
  isOpen: boolean;
  mode: 'create' | 'edit';
  initialTenant?: Tenant | null;
  prefillData?: TenantPrefillData | null;
  onClose: () => void;
  onSaved: (newTenantId?: number) => void;
}

const EMPTY_FORM: TenantFormValues = {
  full_name: '',
  cpf: '',
  rg: '',
  civil_state: '',
  occupation: '',
  reference_address: '',
  phone: '',
  email: '',
  unit_id: '',
  rent_amount: '',
  due_day: '',
  contract_start: '',
  contract_end: '',
  notes: '',
  profile_photo: '',
  document_front_image: '',
  document_back_image: '',
};

const toDateInput = (value: string): string => {
  if (!value || value.length < 10) return '';
  return value.slice(0, 10);
};

function formatCpf(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 11);
  return digits
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 2) return digits ? `(${digits}` : '';
  if (digits.length <= 3) return `(${digits.slice(0, 2)})${digits.slice(2)}`;
  if (digits.length <= 7) return `(${digits.slice(0, 2)})${digits.slice(2, 3)}.${digits.slice(3)}`;
  return `(${digits.slice(0, 2)})${digits.slice(2, 3)}.${digits.slice(3, 7)}-${digits.slice(7)}`;
}

function addMonthsToDate(startDate: Date, months: number): string {
  const date = new Date(startDate);
  date.setMonth(date.getMonth() + months);
  return date.toISOString().slice(0, 10);
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Unable to read file'));
    };
    reader.onerror = () => reject(new Error('Unable to read file'));
    reader.readAsDataURL(file);
  });
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Unable to load image'));
    image.src = src;
  });
}

async function resizeDataUrl(dataUrl: string, maxSize: number): Promise<string> {
  const image = await loadImage(dataUrl);
  const ratio = Math.min(1, maxSize / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * ratio));
  const height = Math.max(1, Math.round(image.height * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return dataUrl;
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.9);
}

async function cropCircleDataUrl(source: string, area: Area): Promise<string> {
  const image = await loadImage(source);
  const size = 512;
  const sx = Math.max(0, Math.round(area.x));
  const sy = Math.max(0, Math.round(area.y));
  const sw = Math.max(1, Math.min(image.width - sx, Math.round(area.width)));
  const sh = Math.max(1, Math.min(image.height - sy, Math.round(area.height)));

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return source;

  context.clearRect(0, 0, size, size);
  context.save();
  context.beginPath();
  context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  context.clip();
  context.drawImage(image, sx, sy, sw, sh, 0, 0, size, size);
  context.restore();

  return canvas.toDataURL('image/jpeg', 0.92);
}

function buildDefaultCreateForm(): TenantFormValues {
  const today = new Date();
  const contractStart = today.toISOString().slice(0, 10);
  return {
    ...EMPTY_FORM,
    contract_start: contractStart,
    contract_end: addMonthsToDate(today, 6),
  };
}

function buildPrefillForm(prefill: TenantPrefillData | null | undefined): TenantFormValues {
  if (!prefill) return buildDefaultCreateForm();

  const today = new Date();
  const contractStart = today.toISOString().slice(0, 10);
  const contractMonths = prefill.contract_months && prefill.contract_months >= 1 && prefill.contract_months <= 12 ? prefill.contract_months : 6;
  const contractEnd = addMonthsToDate(today, contractMonths);

  return {
    ...EMPTY_FORM,
    full_name: prefill.full_name || '',
    cpf: prefill.cpf ? formatCpf(prefill.cpf) : '',
    rg: prefill.rg || '',
    civil_state: prefill.civil_state || '',
    occupation: prefill.occupation || '',
    reference_address: prefill.reference_address || '',
    phone: prefill.phone ? formatPhone(prefill.phone) : '',
    email: prefill.email || '',
    due_day: prefill.due_day ? String(prefill.due_day) : '',
    contract_start: contractStart,
    contract_end: contractEnd,
    document_front_image: prefill.document_front_image || '',
    document_back_image: prefill.document_back_image || '',
  };
}

export const TenantFormModal: React.FC<TenantFormModalProps> = ({
  isOpen,
  mode,
  initialTenant,
  prefillData,
  onClose,
  onSaved,
}) => {
  const [form, setForm] = useState<TenantFormValues>(EMPTY_FORM);
  const [units, setUnits] = useState<UnitItem[]>([]);
  const [loadingUnits, setLoadingUnits] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [cropSource, setCropSource] = useState('');
  const [cropZoom, setCropZoom] = useState(1);
  const [cropPoint, setCropPoint] = useState<Point>({ x: 0, y: 0 });
  const [cropAreaPixels, setCropAreaPixels] = useState<Area | null>(null);
  const [cropSaving, setCropSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    if (mode === 'edit' && initialTenant) {
      setForm({
        full_name: initialTenant.full_name || '',
        cpf: initialTenant.cpf ? formatCpf(initialTenant.cpf) : '',
        rg: initialTenant.rg || '',
        civil_state: initialTenant.civil_state || '',
        occupation: initialTenant.occupation || '',
        reference_address: initialTenant.reference_address || '',
        phone: initialTenant.phone ? formatPhone(initialTenant.phone) : '',
        email: initialTenant.email || '',
        unit_id: initialTenant.unit_id > 0 ? String(initialTenant.unit_id) : '',
        rent_amount: initialTenant.rent_amount > 0 ? String(initialTenant.rent_amount) : '',
        due_day: initialTenant.due_day > 0 ? String(initialTenant.due_day) : '',
        contract_start: toDateInput(initialTenant.contract_start),
        contract_end: toDateInput(initialTenant.contract_end),
        notes: initialTenant.notes || '',
        profile_photo: initialTenant.profile_photo || '',
        document_front_image: initialTenant.document_front_image || '',
        document_back_image: initialTenant.document_back_image || '',
      });
    } else {
      setForm(prefillData ? buildPrefillForm(prefillData) : buildDefaultCreateForm());
    }

    setError('');
    setCropSource('');
  }, [isOpen, mode, initialTenant, prefillData]);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    const loadUnits = async () => {
      setLoadingUnits(true);
      try {
        const response = await apiGet<{ items: UnitItem[] }>('/api/units');
        if (!cancelled) {
          setUnits(response.items || []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load units.');
        }
      } finally {
        if (!cancelled) {
          setLoadingUnits(false);
        }
      }
    };

    void loadUnits();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const availableUnits = useMemo(() => {
    const currentTenantId = initialTenant?.id || 0;
    return units.filter((unit) => unit.is_active && (unit.tenant_id === 0 || unit.tenant_id === currentTenantId));
  }, [initialTenant?.id, units]);

  const setField = (key: keyof TenantFormValues, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const onUploadDocument = async (side: 'front' | 'back', file: File) => {
    try {
      const dataUrl = await fileToDataUrl(file);
      const compressed = await resizeDataUrl(dataUrl, 1400);
      if (side === 'front') {
        setField('document_front_image', compressed);
      } else {
        setField('document_back_image', compressed);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to process image.');
    }
  };

  const onUploadProfile = async (file: File) => {
    try {
      const dataUrl = await fileToDataUrl(file);
      setCropSource(dataUrl);
      setCropZoom(1);
      setCropPoint({ x: 0, y: 0 });
      setCropAreaPixels(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to process profile image.');
    }
  };

  const openCropForImage = (source: string) => {
    setCropSource(source);
    setCropZoom(1);
    setCropPoint({ x: 0, y: 0 });
    setCropAreaPixels(null);
  };

  const applyCrop = async () => {
    if (!cropAreaPixels) {
      setError('Adjust the crop area before applying.');
      return;
    }
    setCropSaving(true);
    try {
      const output = await cropCircleDataUrl(cropSource, cropAreaPixels);
      setField('profile_photo', output);
      setCropSource('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to crop profile image.');
    } finally {
      setCropSaving(false);
    }
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');

    if (!form.full_name.trim() || !form.cpf.trim() || !form.rent_amount.trim() || !form.due_day.trim()) {
      setError('Full name, CPF, rent amount and due day are required.');
      return;
    }

    const dueDay = Number(form.due_day);
    if (!Number.isFinite(dueDay) || dueDay < 1 || dueDay > 28) {
      setError('Due day must be a number between 1 and 28.');
      return;
    }

    const payload = {
      full_name: form.full_name.trim(),
      cpf: form.cpf.replace(/\D/g, ''),
      rg: form.rg.replace(/\D/g, ''),
      civil_state: form.civil_state.trim(),
      occupation: form.occupation.trim(),
      reference_address: form.reference_address.trim(),
      phone: form.phone.replace(/\D/g, ''),
      email: form.email.trim(),
      unit_id: form.unit_id ? Number(form.unit_id) : 0,
      rent_amount: Number(form.rent_amount),
      due_day: dueDay,
      contract_start: form.contract_start || '',
      contract_end: form.contract_end || '',
      notes: form.notes.trim(),
      profile_photo: form.profile_photo,
      document_front_image: form.document_front_image,
      document_back_image: form.document_back_image,
    };

    setSaving(true);
    try {
      let newTenantId: number | undefined;
      if (mode === 'create') {
        const res = await apiPost<{ id: number }>('/api/tenants', payload);
        newTenantId = res.id;
      } else if (initialTenant) {
        await apiPut(`/api/tenants/${initialTenant.id}`, payload);
      }
      window.dispatchEvent(new CustomEvent('oc:data-refresh'));
      onSaved(newTenantId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save tenant.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={mode === 'create' ? 'Create New Tenant' : `Edit Tenant #${initialTenant?.id ?? ''}`}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="tenant-form" disabled={saving}>
              {saving ? 'Saving...' : mode === 'create' ? 'Create Tenant' : 'Save Changes'}
            </Button>
          </>
        }
      >
        <form id="tenant-form" className={styles.form} onSubmit={onSubmit}>
          {error && <div className={styles.error}>{error}</div>}

          <div className={styles.profileRow}>
            <div className={styles.profilePreview}>
              {form.profile_photo ? (
                <img src={form.profile_photo} alt="Profile" />
              ) : (
                <span>{(form.full_name || 'T').charAt(0).toUpperCase()}</span>
              )}
            </div>
            <div className={styles.profileActions}>
              <label className={styles.fileButton}>
                <Upload size={14} />
                Upload profile photo
                <input
                  type="file"
                  accept="image/*"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void onUploadProfile(file);
                    event.currentTarget.value = '';
                  }}
                />
              </label>
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => {
                  if (form.document_front_image) {
                    openCropForImage(form.document_front_image);
                  }
                }}
                disabled={!form.document_front_image}
              >
                Use front document image
              </button>
              <button type="button" className={styles.linkBtn} onClick={() => form.profile_photo && openCropForImage(form.profile_photo)} disabled={!form.profile_photo}>
                Edit current photo
              </button>
            </div>
          </div>

          <div className={styles.grid}>
            <div className={`${styles.field} ${styles.span2}`}>
              <label className={styles.label}>Full Name *</label>
              <input className={styles.input} value={form.full_name} onChange={(e) => setField('full_name', e.target.value)} />
            </div>

            <div className={styles.field}>
              <label className={styles.label}>CPF *</label>
              <input
                className={styles.input}
                inputMode="numeric"
                value={form.cpf}
                onChange={(e) => setField('cpf', formatCpf(e.target.value))}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>RG</label>
              <input
                className={styles.input}
                inputMode="numeric"
                value={form.rg}
                onChange={(e) => setField('rg', e.target.value.replace(/\D/g, '').slice(0, 9))}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Civil State</label>
              <input className={styles.input} value={form.civil_state} onChange={(e) => setField('civil_state', e.target.value)} />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Occupation</label>
              <input className={styles.input} value={form.occupation} onChange={(e) => setField('occupation', e.target.value)} />
            </div>

            <div className={`${styles.field} ${styles.span2}`}>
              <label className={styles.label}>Reference Address</label>
              <input
                className={styles.input}
                value={form.reference_address}
                onChange={(e) => setField('reference_address', e.target.value)}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Phone</label>
              <input
                className={styles.input}
                inputMode="numeric"
                value={form.phone}
                onChange={(e) => setField('phone', formatPhone(e.target.value))}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Email</label>
              <input className={styles.input} type="email" value={form.email} onChange={(e) => setField('email', e.target.value)} />
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Assigned Unit</label>
              <select className={styles.select} value={form.unit_id} onChange={(e) => setField('unit_id', e.target.value)} disabled={loadingUnits}>
                <option value="">No unit assigned</option>
                {availableUnits.map((unit) => (
                  <option key={unit.id} value={String(unit.id)}>
                    {unit.unit_number}
                    {unit.tenant_id > 0 ? ' (current)' : ''}
                  </option>
                ))}
              </select>
              <span className={styles.hint}>Only active and free units are shown.</span>
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Rent Amount *</label>
              <input
                className={styles.input}
                type="number"
                min="0"
                step="0.01"
                value={form.rent_amount}
                onChange={(e) => setField('rent_amount', e.target.value)}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Payment Due Day (1-28) *</label>
              <input
                className={styles.input}
                type="number"
                inputMode="numeric"
                min="1"
                max="28"
                value={form.due_day}
                onChange={(e) => setField('due_day', e.target.value)}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Contract Start Date</label>
              <input className={styles.input} type="date" value={form.contract_start} onChange={(e) => setField('contract_start', e.target.value)} />
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Contract End Date</label>
              <input className={styles.input} type="date" value={form.contract_end} onChange={(e) => setField('contract_end', e.target.value)} />
            </div>

            <div className={`${styles.field} ${styles.span2}`}>
              <label className={styles.label}>Document Photos</label>
              <div className={styles.documentGrid}>
                <div className={styles.documentCard}>
                  {form.document_front_image ? (
                    <img src={form.document_front_image} alt="Document front" />
                  ) : (
                    <span>
                      <ImageIcon size={16} /> Front
                    </span>
                  )}
                  <label className={styles.fileButton}>
                    <Upload size={14} />
                    Upload front
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void onUploadDocument('front', file);
                        event.currentTarget.value = '';
                      }}
                    />
                  </label>
                </div>

                <div className={styles.documentCard}>
                  {form.document_back_image ? (
                    <img src={form.document_back_image} alt="Document back" />
                  ) : (
                    <span>
                      <ImageIcon size={16} /> Back
                    </span>
                  )}
                  <label className={styles.fileButton}>
                    <Upload size={14} />
                    Upload back
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void onUploadDocument('back', file);
                        event.currentTarget.value = '';
                      }}
                    />
                  </label>
                </div>
              </div>
            </div>

            <div className={`${styles.field} ${styles.span2}`}>
              <label className={styles.label}>Notes</label>
              <textarea className={styles.textarea} value={form.notes} onChange={(e) => setField('notes', e.target.value)} />
            </div>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={Boolean(cropSource)}
        onClose={() => setCropSource('')}
        title="Crop profile photo"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCropSource('')} disabled={cropSaving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void applyCrop()} disabled={cropSaving}>
              {cropSaving ? 'Applying...' : 'Apply Crop'}
            </Button>
          </>
        }
      >
        <div className={styles.cropperWrap}>
          <div className={styles.cropPreview}>
            {cropSource && (
              <Cropper
                image={cropSource}
                crop={cropPoint}
                zoom={cropZoom}
                aspect={1}
                cropShape="round"
                showGrid={false}
                objectFit="contain"
                onCropChange={setCropPoint}
                onZoomChange={setCropZoom}
                onCropComplete={(_, croppedAreaPixels) => setCropAreaPixels(croppedAreaPixels)}
              />
            )}
          </div>

          <label className={styles.sliderField}>
            <span>Zoom</span>
            <input type="range" min="1" max="3" step="0.01" value={cropZoom} onChange={(e) => setCropZoom(Number(e.target.value))} />
          </label>
        </div>
      </Modal>
    </>
  );
};
