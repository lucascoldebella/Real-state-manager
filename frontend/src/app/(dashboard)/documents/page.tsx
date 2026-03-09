'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Card } from '../../../components/ui/Card/Card';
import { FileText, Download, FilePlus, Search, Eye } from 'lucide-react';
import { apiGet, apiPost, apiPut, downloadWithAuth } from '../../../lib/api';
import type { DocumentItem, DocumentTemplate, Tenant } from '../../../lib/types';
import styles from './page.module.css';

type DocFilter = 'all' | 'rental_contract' | 'payment_receipt' | 'other';

const DOC_FILTER_LABEL: Record<DocFilter, string> = {
  all: 'All templates',
  rental_contract: 'Contracts',
  payment_receipt: 'Receipts',
  other: 'Other',
};

const filterType = (type: string): DocFilter => {
  if (type === 'rental_contract') return 'rental_contract';
  if (type === 'payment_receipt') return 'payment_receipt';
  return 'other';
};

interface CollectionDrafts {
  due_note: string;
  overdue_note: string;
  eviction_notice: string;
}

const EMPTY_DRAFTS: CollectionDrafts = {
  due_note: '',
  overdue_note: '',
  eviction_notice: '',
};

export default function DocumentsPage() {
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<DocFilter>('all');
  const [templateId, setTemplateId] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [generating, setGenerating] = useState(false);
  const [drafts, setDrafts] = useState<CollectionDrafts>(EMPTY_DRAFTS);
  const [savingDrafts, setSavingDrafts] = useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [templatesRes, docsRes, tenantsRes] = await Promise.all([
        apiGet<{ items: DocumentTemplate[] }>('/api/document-templates'),
        apiGet<{ items: DocumentItem[] }>('/api/documents'),
        apiGet<{ items: Tenant[] }>('/api/tenants'),
      ]);
      setTemplates(templatesRes.items || []);
      setDocuments(docsRes.items || []);
      setTenants((tenantsRes.items || []).filter((tenant) => tenant.active));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load documents module.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onRefresh = () => void load();
    window.addEventListener('oc:data-refresh', onRefresh);
    return () => window.removeEventListener('oc:data-refresh', onRefresh);
  }, [load]);

  useEffect(() => {
    if (!templateId && templates.length > 0) {
      setTemplateId(String(templates[0].id));
    }
    if (!tenantId && tenants.length > 0) {
      setTenantId(String(tenants[0].id));
    }
  }, [templateId, tenantId, templates, tenants]);

  useEffect(() => {
    const pickBody = (type: keyof CollectionDrafts, fallback: string) =>
      templates.find((template) => template.document_type === type)?.template_body || fallback;
    setDrafts({
      due_note: pickBody(
        'due_note',
        'Hello {{tenant_name}}, this is a reminder that rent for unit {{unit_number}} is due on {{due_date}}. Amount: {{rent_value}}.',
      ),
      overdue_note: pickBody(
        'overdue_note',
        'Hello {{tenant_name}}, rent for unit {{unit_number}} is overdue since {{due_date}}. Outstanding amount: {{rent_value}}.',
      ),
      eviction_notice: pickBody('eviction_notice', '{{tenant_name}} - Unit {{unit_number}}'),
    });
  }, [templates]);

  const filteredTemplates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates.filter((template) => {
      const matchesType = filter === 'all' || filterType(template.document_type) === filter;
      if (!matchesType) return false;
      if (!q) return true;
      return `${template.name} ${template.document_type}`.toLowerCase().includes(q);
    });
  }, [filter, query, templates]);

  const filteredDocuments = useMemo(() => {
    if (filter === 'all') return documents;
    return documents.filter((doc) => filterType(doc.document_type) === filter);
  }, [documents, filter]);

  const generateDocument = async () => {
    if (!templateId || !tenantId) {
      setError('Select a template and tenant before generating.');
      return;
    }

    setGenerating(true);
    setError('');
    try {
      const payload = {
        template_id: Number(templateId),
        tenant_id: Number(tenantId),
      };
      await apiPost('/api/documents/generate', payload);
      window.dispatchEvent(new CustomEvent('oc:data-refresh'));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Document generation failed.');
    } finally {
      setGenerating(false);
    }
  };

  const downloadDocument = async (doc: DocumentItem) => {
    try {
      await downloadWithAuth(doc.download_url, `document-${doc.id}.pdf`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed.');
    }
  };

  const upsertTemplate = async (docType: keyof CollectionDrafts, name: string, templateBody: string): Promise<void> => {
    const existing = templates.find((template) => template.document_type === docType);
    if (existing) {
      await apiPut(`/api/document-templates/${existing.id}`, {
        name: existing.name || name,
        document_type: docType,
        template_body: templateBody,
      });
      return;
    }
    await apiPost('/api/document-templates', {
      name,
      document_type: docType,
      template_body: templateBody,
    });
  };

  const saveCollectionDrafts = async () => {
    setSavingDrafts(true);
    setError('');
    try {
      await Promise.all([
        upsertTemplate('due_note', 'Due Date Reminder', drafts.due_note.trim()),
        upsertTemplate('overdue_note', 'Overdue Notification', drafts.overdue_note.trim()),
        upsertTemplate('eviction_notice', 'Eviction Notice Template', drafts.eviction_notice.trim()),
      ]);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save collection templates.');
    } finally {
      setSavingDrafts(false);
    }
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <h2>Document Center</h2>
          <p>Separated by category: contracts, receipts, and other templates with generated history.</p>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.searchContainer}>
            <Search size={18} className={styles.searchIcon} />
            <input
              type="text"
              placeholder="Search templates..."
              className={styles.searchInput}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button className={styles.generateBtn} onClick={() => void generateDocument()} disabled={generating}>
            <FilePlus size={18} />
            {generating ? 'Generating...' : 'Generate Document'}
          </button>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.segmented}>
        {(['all', 'rental_contract', 'payment_receipt', 'other'] as DocFilter[]).map((docFilter) => (
          <button
            key={docFilter}
            className={`${styles.segmentBtn} ${filter === docFilter ? styles.segmentBtnActive : ''}`}
            onClick={() => setFilter(docFilter)}
          >
            {DOC_FILTER_LABEL[docFilter]}
          </button>
        ))}
      </div>

      <div className={styles.contentGrid}>
        <div className={styles.mainSection}>
          <Card className={styles.tableCard}>
            <div className={styles.tableHeader}>
              <h3 className={styles.tableTitle}>Templates</h3>
            </div>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Document Name</th>
                    <th>Category</th>
                    <th>Created</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTemplates.map((template) => (
                    <tr key={template.id}>
                      <td>
                        <div className={styles.docInfo}>
                          <div className={styles.docIcon}>
                            <FileText size={18} />
                          </div>
                          <span className={styles.docTitle}>{template.name}</span>
                        </div>
                      </td>
                      <td>
                        <span className={styles.docType}>{template.document_type}</span>
                      </td>
                      <td className={styles.docUpdated}>{template.created_at}</td>
                      <td className={styles.actionsCell}>
                        <button className={styles.downloadBtn} onClick={() => setTemplateId(String(template.id))}>
                          Select
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!loading && filteredTemplates.length === 0 && <div className={styles.empty}>No templates found for this filter.</div>}
            </div>
          </Card>

          <Card className={styles.tableCard}>
            <div className={styles.tableHeader}>
              <h3 className={styles.tableTitle}>Generated Documents</h3>
            </div>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Tenant</th>
                    <th>Generated At</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDocuments.map((doc) => (
                    <tr key={doc.id}>
                      <td>
                        <span className={styles.docType}>{doc.document_type}</span>
                      </td>
                      <td>{doc.tenant_name}</td>
                      <td className={styles.docUpdated}>{doc.generated_at}</td>
                      <td className={styles.actionsCell}>
                        <button className={styles.downloadBtn} onClick={() => void downloadDocument(doc)}>
                          <Download size={16} /> Download
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!loading && filteredDocuments.length === 0 && <div className={styles.empty}>No generated documents in this category.</div>}
            </div>
          </Card>
        </div>

        <div className={styles.sideSection}>
          <Card className={styles.generatorCard}>
            <h3 className={styles.generatorTitle}>Contrato de Locação</h3>
            <p className={styles.generatorDesc}>Modelo padrão de contrato residencial com todas as cláusulas e formatação profissional.</p>
            <Link href="/documents/contract" style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '10px 16px', background: 'var(--primary)', color: 'white',
              borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.875rem',
              textDecoration: 'none', transition: 'all 150ms', width: '100%', justifyContent: 'center',
            }}>
              <Eye size={16} />
              Visualizar Modelo de Contrato
            </Link>
          </Card>

          <Card className={styles.generatorCard}>
            <h3 className={styles.generatorTitle}>Quick Generator</h3>
            <p className={styles.generatorDesc}>Generate a populated PDF from a selected template and tenant profile.</p>

            <div className={styles.formGroup}>
              <label>Select Template</label>
              <select className={styles.select} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                {templates.map((template) => (
                  <option key={template.id} value={String(template.id)}>
                    {template.name} ({template.document_type})
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.formGroup}>
              <label>Tenant / Unit</label>
              <select className={styles.select} value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
                {tenants.map((tenant) => (
                  <option key={tenant.id} value={String(tenant.id)}>
                    {tenant.full_name} {tenant.unit_number ? `- Unit ${tenant.unit_number}` : ''}
                  </option>
                ))}
              </select>
            </div>

            <button className={styles.generateActionBtn} onClick={() => void generateDocument()} disabled={generating}>
              {generating ? 'Generating...' : 'Generate PDF'}
            </button>
          </Card>

          <Card className={styles.generatorCard}>
            <h3 className={styles.generatorTitle}>Collection Message Templates</h3>
            <p className={styles.generatorDesc}>
              Editable text used by Property Control Center clipboard actions and eviction PDF generation.
            </p>

            <div className={styles.formGroup}>
              <label>Due Date Note</label>
              <textarea
                className={styles.templateArea}
                value={drafts.due_note}
                onChange={(e) => setDrafts((prev) => ({ ...prev, due_note: e.target.value }))}
              />
            </div>

            <div className={styles.formGroup}>
              <label>Overdue Notification</label>
              <textarea
                className={styles.templateArea}
                value={drafts.overdue_note}
                onChange={(e) => setDrafts((prev) => ({ ...prev, overdue_note: e.target.value }))}
              />
            </div>

            <div className={styles.formGroup}>
              <label>Eviction Notice Template</label>
              <textarea
                className={styles.templateArea}
                value={drafts.eviction_notice}
                onChange={(e) => setDrafts((prev) => ({ ...prev, eviction_notice: e.target.value }))}
              />
            </div>

            <div className={styles.placeholderHint}>
              Available placeholders: <code>{'{{tenant_name}}'}</code>, <code>{'{{cpf}}'}</code>, <code>{'{{rent_value}}'}</code>,{' '}
              <code>{'{{due_date}}'}</code>, <code>{'{{unit_number}}'}</code>
            </div>

            <button className={styles.generateActionBtn} onClick={() => void saveCollectionDrafts()} disabled={savingDrafts}>
              {savingDrafts ? 'Saving...' : 'Save message templates'}
            </button>
          </Card>
        </div>
      </div>
    </div>
  );
}
