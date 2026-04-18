'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { FileText, Receipt, MessageSquare, FolderOpen, ArrowRight, ScrollText, Clock } from 'lucide-react';
import { apiGet, apiPut, apiPost } from '../../../lib/api';
import { Modal } from '../../../components/ui/Modal/Modal';
import type { DocumentItem, DocumentTemplate, Tenant } from '../../../lib/types';
import styles from './page.module.css';

interface CollectionDrafts {
  due_note: string;
  overdue_note: string;
  eviction_notice: string;
}

export default function DocumentsPage() {
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCollectionModal, setShowCollectionModal] = useState(false);
  const [drafts, setDrafts] = useState<CollectionDrafts>({ due_note: '', overdue_note: '', eviction_notice: '' });
  const [savingDrafts, setSavingDrafts] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [templatesRes, docsRes, tenantsRes] = await Promise.all([
        apiGet<{ items: DocumentTemplate[] }>('/api/document-templates'),
        apiGet<{ items: DocumentItem[] }>('/api/documents'),
        apiGet<{ items: Tenant[] }>('/api/tenants'),
      ]);
      setTemplates(templatesRes.items || []);
      setDocuments(docsRes.items || []);
      setTenants((tenantsRes.items || []).filter((t) => t.active));
    } catch {
      // silent load
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const pickBody = (type: string, fallback: string) =>
      templates.find((t) => t.document_type === type)?.template_body || fallback;
    setDrafts({
      due_note: pickBody('due_note', 'Hello {{tenant_name}}, this is a reminder that rent for unit {{unit_number}} is due on {{due_date}}. Amount: {{rent_value}}.'),
      overdue_note: pickBody('overdue_note', 'Hello {{tenant_name}}, rent for unit {{unit_number}} is overdue since {{due_date}}. Outstanding amount: {{rent_value}}.'),
      eviction_notice: pickBody('eviction_notice', '{{tenant_name}} - Unit {{unit_number}}'),
    });
  }, [templates]);

  const contractCount = documents.filter((d) => d.document_type === 'rental_contract').length;
  const invoiceCount = documents.filter((d) => d.document_type === 'payment_receipt' || d.document_type === 'invoice').length;
  const activeTenants = tenants.length;
  const expiringContracts = tenants.filter((t) => {
    if (!t.contract_end) return false;
    const end = new Date(t.contract_end);
    const now = new Date();
    const diff = (end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    return diff >= 0 && diff <= 30;
  }).length;

  const upsertTemplate = async (docType: string, name: string, templateBody: string) => {
    const existing = templates.find((t) => t.document_type === docType);
    if (existing) {
      await apiPut(`/api/document-templates/${existing.id}`, { name: existing.name || name, document_type: docType, template_body: templateBody });
    } else {
      await apiPost('/api/document-templates', { name, document_type: docType, template_body: templateBody });
    }
  };

  const saveCollectionDrafts = async () => {
    setSavingDrafts(true);
    setSaveSuccess(false);
    try {
      await Promise.all([
        upsertTemplate('due_note', 'Due Date Reminder', drafts.due_note.trim()),
        upsertTemplate('overdue_note', 'Overdue Notification', drafts.overdue_note.trim()),
        upsertTemplate('eviction_notice', 'Eviction Notice Template', drafts.eviction_notice.trim()),
      ]);
      await load();
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch {
      // silent
    } finally {
      setSavingDrafts(false);
    }
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerContent}>
          <div className={styles.headerIcon}>
            <FolderOpen size={28} />
          </div>
          <div>
            <h2 className={styles.headerTitle}>Central de Documentos</h2>
            <p className={styles.headerDesc}>Gerencie contratos, recibos e modelos de cobrança do seu imóvel.</p>
          </div>
        </div>
        <div className={styles.headerStats}>
          <div className={styles.statPill}>
            <ScrollText size={14} />
            <span>{activeTenants} inquilinos ativos</span>
          </div>
          {expiringContracts > 0 && (
            <div className={`${styles.statPill} ${styles.statPillWarning}`}>
              <Clock size={14} />
              <span>{expiringContracts} contrato{expiringContracts > 1 ? 's' : ''} vencendo</span>
            </div>
          )}
        </div>
      </header>

      <div className={styles.blocksGrid}>
        {/* CONTRACTS BLOCK */}
        <Link href="/documents/contract" className={styles.block}>
          <div className={styles.blockIconWrap}>
            <div className={`${styles.blockIcon} ${styles.blockIconContracts}`}>
              <FileText size={32} />
            </div>
          </div>
          <div className={styles.blockBody}>
            <h3 className={styles.blockTitle}>Contratos de Locação</h3>
            <p className={styles.blockDesc}>
              Modelo padrão de contrato residencial com cláusulas completas. Gere contratos preenchidos para cada inquilino.
            </p>
            <div className={styles.blockMeta}>
              <span className={styles.blockCount}>{loading ? '...' : `${contractCount} gerado${contractCount !== 1 ? 's' : ''}`}</span>
              <span className={styles.blockDot} />
              <span className={styles.blockCount}>{loading ? '...' : `${activeTenants} inquilino${activeTenants !== 1 ? 's' : ''}`}</span>
            </div>
          </div>
          <div className={styles.blockAction}>
            <span>Abrir</span>
            <ArrowRight size={16} />
          </div>
        </Link>

        {/* INVOICES BLOCK */}
        <Link href="/documents/invoices" className={styles.block}>
          <div className={styles.blockIconWrap}>
            <div className={`${styles.blockIcon} ${styles.blockIconInvoices}`}>
              <Receipt size={32} />
            </div>
          </div>
          <div className={styles.blockBody}>
            <h3 className={styles.blockTitle}>Recibos de Pagamento</h3>
            <p className={styles.blockDesc}>
              Gere recibos profissionais baseados nos pagamentos registrados. Visualize e baixe em PDF.
            </p>
            <div className={styles.blockMeta}>
              <span className={styles.blockCount}>{loading ? '...' : `${invoiceCount} gerado${invoiceCount !== 1 ? 's' : ''}`}</span>
            </div>
          </div>
          <div className={styles.blockAction}>
            <span>Abrir</span>
            <ArrowRight size={16} />
          </div>
        </Link>

        {/* COLLECTION MESSAGES BLOCK */}
        <button className={styles.block} onClick={() => setShowCollectionModal(true)}>
          <div className={styles.blockIconWrap}>
            <div className={`${styles.blockIcon} ${styles.blockIconMessages}`}>
              <MessageSquare size={32} />
            </div>
          </div>
          <div className={styles.blockBody}>
            <h3 className={styles.blockTitle}>Modelos de Cobrança</h3>
            <p className={styles.blockDesc}>
              Templates editáveis para avisos de vencimento, atrasos e notificações de despejo.
            </p>
            <div className={styles.blockMeta}>
              <span className={styles.blockCount}>3 modelos</span>
            </div>
          </div>
          <div className={styles.blockAction}>
            <span>Editar</span>
            <ArrowRight size={16} />
          </div>
        </button>
      </div>

      {/* COLLECTION MESSAGES MODAL */}
      <Modal isOpen={showCollectionModal} onClose={() => setShowCollectionModal(false)} title="Modelos de Cobrança" size="lg">
        <div className={styles.collectionForm}>
          <p className={styles.collectionDesc}>
            Textos editáveis usados para geração de documentos de cobrança e avisos aos inquilinos.
          </p>

          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Aviso de Vencimento</label>
            <textarea
              className={styles.textarea}
              value={drafts.due_note}
              onChange={(e) => setDrafts((p) => ({ ...p, due_note: e.target.value }))}
              rows={4}
            />
          </div>

          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Notificação de Atraso</label>
            <textarea
              className={styles.textarea}
              value={drafts.overdue_note}
              onChange={(e) => setDrafts((p) => ({ ...p, overdue_note: e.target.value }))}
              rows={4}
            />
          </div>

          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Modelo de Notificação de Despejo</label>
            <textarea
              className={styles.textarea}
              value={drafts.eviction_notice}
              onChange={(e) => setDrafts((p) => ({ ...p, eviction_notice: e.target.value }))}
              rows={4}
            />
          </div>

          <div className={styles.placeholderHint}>
            Placeholders disponíveis: <code>{'{{tenant_name}}'}</code>, <code>{'{{cpf}}'}</code>, <code>{'{{rent_value}}'}</code>, <code>{'{{due_date}}'}</code>, <code>{'{{unit_number}}'}</code>
          </div>

          <button
            className={`${styles.saveBtn} ${saveSuccess ? styles.saveBtnSuccess : ''}`}
            onClick={() => void saveCollectionDrafts()}
            disabled={savingDrafts}
          >
            {savingDrafts ? 'Salvando...' : saveSuccess ? 'Salvo!' : 'Salvar modelos'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
