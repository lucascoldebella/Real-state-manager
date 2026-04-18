'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Download,
  Printer,
  ZoomIn,
  ZoomOut,
  Receipt,
  FileText,
  Users,
  Calendar,
  Pencil,
  Eye,
  Save,
  Lock,
  AlertTriangle,
  CheckCircle2,
  Trash2,
  X,
  History,
  Bold,
  Italic,
  Underline,
  AlignLeft,
  AlignCenter,
  AlignRight,
} from 'lucide-react';
import { apiGet, apiPost, apiPut, apiDelete, getStoredUser } from '../../../../lib/api';
import type { Tenant, PaymentItem, DocumentTemplate, DocumentItem } from '../../../../lib/types';
import {
  formatDateBR,
  formatMoneyBR,
  monthLabel,
  buildReceiptPlaceholders,
  applyPlaceholders,
} from '../../../../lib/document-helpers';
import styles from './page.module.css';

type ViewMode = 'dashboard' | 'master' | 'receipt';

const getAvailableMonths = (): string[] => {
  const months: string[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
};

export default function InvoiceDashboardPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [payments, setPayments] = useState<PaymentItem[]>([]);
  const [allReceipts, setAllReceipts] = useState<DocumentItem[]>([]);
  const [masterTemplate, setMasterTemplate] = useState<DocumentTemplate | null>(null);

  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [selectedMonth, setSelectedMonth] = useState('');

  const [activeReceipt, setActiveReceipt] = useState<DocumentItem | null>(null);
  const [editorHtml, setEditorHtml] = useState<string>('');
  const [originalHtml, setOriginalHtml] = useState<string>('');

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [toast, setToast] = useState('');
  const [view, setView] = useState<ViewMode>('dashboard');
  const [editMode, setEditMode] = useState(false);
  const [showConfirmGenerate, setShowConfirmGenerate] = useState(false);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);

  const docRef = useRef<HTMLDivElement>(null);
  const contentEditableRef = useRef<HTMLDivElement>(null);

  // Sync editorHtml → DOM imperatively so React never resets innerHTML during typing.
  // editMode in deps ensures the freshly-mounted contentEditable div gets populated.
  useEffect(() => {
    const el = contentEditableRef.current;
    if (!el) return;
    if (el.innerHTML !== editorHtml) {
      el.innerHTML = editorHtml;
    }
  }, [editorHtml, editMode]);

  const availableMonths = useMemo(() => getAvailableMonths(), []);

  const user = getStoredUser();
  const isRoot = user?.is_root === true;

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [tenantsRes, templatesRes, docsRes] = await Promise.all([
        apiGet<{ items: Tenant[] }>('/api/tenants'),
        apiGet<{ items: DocumentTemplate[] }>('/api/document-templates'),
        apiGet<{ items: DocumentItem[] }>('/api/documents'),
      ]);
      const active = (tenantsRes.items || []).filter((t) => t.active);
      setTenants(active);
      const master = (templatesRes.items || []).find(
        (t) => t.document_type === 'payment_receipt_master',
      ) || null;
      setMasterTemplate(master);
      setAllReceipts((docsRes.items || []).filter((d) => d.document_type === 'payment_receipt'));
      if (active.length > 0 && !selectedTenantId) setSelectedTenantId(String(active[0].id));
      if (!selectedMonth) setSelectedMonth(availableMonths[0]);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableMonths]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!selectedTenantId) return;
    (async () => {
      try {
        const res = await apiGet<{ items: PaymentItem[] }>(
          `/api/payments?tenant_id=${selectedTenantId}`,
        );
        setPayments(res.items || []);
      } catch {
        setPayments([]);
      }
    })();
  }, [selectedTenantId]);

  const tenant = tenants.find((t) => t.id === Number(selectedTenantId)) || null;
  const payment = payments.find((p) => p.month === selectedMonth) || null;
  const tenantPayments = payments.filter((p) => p.status === 'paid');

  const tenantReceipts = useMemo(
    () => (tenant ? allReceipts.filter((r) => r.tenant_id === tenant.id) : []),
    [allReceipts, tenant],
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }, []);

  const handlePrint = () => window.print();

  const handleDownloadPDF = async () => {
    showToast('Gerando PDF...');
    const el = docRef.current;
    if (!el) return;
    const html2pdf = (await import('html2pdf.js')).default;
    const baseName = view === 'master'
      ? 'Recibo_Modelo'
      : tenant
        ? `Recibo_${tenant.full_name.replace(/\s+/g, '_')}_${selectedMonth || ''}`
        : 'Recibo';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (html2pdf() as any).set({
      margin: 0,
      filename: `${baseName}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['avoid-all', 'css', 'legacy'] },
    }).from(el).save().then(() => showToast('PDF salvo com sucesso!'));
  };

  const zoomIn = () => setZoom((z) => Math.min(200, z + 10));
  const zoomOut = () => setZoom((z) => Math.max(50, z - 10));

  const dirty = editorHtml !== originalHtml;

  const openMasterEditor = () => {
    if (!masterTemplate) {
      showToast('Modelo mestre não encontrado.');
      return;
    }
    setEditorHtml(masterTemplate.template_body);
    setOriginalHtml(masterTemplate.template_body);
    setActiveReceipt(null);
    setEditMode(true);
    setView('master');
  };

  const openReceiptPreview = () => {
    if (!tenant || !masterTemplate) {
      showToast('Selecione inquilino e mês.');
      return;
    }
    const placeholders = buildReceiptPlaceholders(tenant, payment, selectedMonth);
    const filled = applyPlaceholders(masterTemplate.template_body, placeholders);
    setEditorHtml(filled);
    setOriginalHtml(filled);
    setActiveReceipt(null);
    setEditMode(false);
    setView('receipt');
  };

  const openExistingReceipt = async (receiptId: number) => {
    setBusy(true);
    setView('receipt');
    try {
      const full = await apiGet<DocumentItem>(`/api/documents/${receiptId}`);
      setActiveReceipt(full);
      setEditorHtml(full.content_html || '');
      setOriginalHtml(full.content_html || '');
      const tnt = tenants.find((t) => t.id === full.tenant_id);
      if (tnt) setSelectedTenantId(String(tnt.id));
      if (full.reference_month) setSelectedMonth(full.reference_month);
    } catch {
      showToast('Falha ao abrir recibo.');
    } finally {
      setBusy(false);
    }
  };

  const saveMasterTemplate = async () => {
    if (!masterTemplate || !dirty) return;
    setBusy(true);
    try {
      await apiPut(`/api/document-templates/${masterTemplate.id}`, {
        name: masterTemplate.name,
        document_type: masterTemplate.document_type,
        template_body: editorHtml,
      });
      setMasterTemplate({ ...masterTemplate, template_body: editorHtml });
      setOriginalHtml(editorHtml);
      showToast('Modelo de recibo salvo!');
    } catch {
      showToast('Falha ao salvar modelo.');
    } finally {
      setBusy(false);
    }
  };

  const generateReceipt = async () => {
    if (!tenant) return;
    setShowConfirmGenerate(false);
    setBusy(true);
    try {
      const res = await apiPost<{ id: number; message: string }>('/api/documents/save', {
        tenant_id: tenant.id,
        document_type: 'payment_receipt',
        content_html: editorHtml,
        reference_month: selectedMonth,
      });
      const full = await apiGet<DocumentItem>(`/api/documents/${res.id}`);
      setActiveReceipt(full);
      setOriginalHtml(full.content_html || '');
      setEditorHtml(full.content_html || '');
      await loadAll();
      showToast('Recibo gerado e arquivado!');
    } catch {
      showToast('Falha ao gerar recibo.');
    } finally {
      setBusy(false);
    }
  };

  const updateLockedReceipt = async () => {
    if (!activeReceipt || !isRoot || !dirty) return;
    setBusy(true);
    try {
      await apiPut(`/api/documents/${activeReceipt.id}`, { content_html: editorHtml });
      setOriginalHtml(editorHtml);
      showToast('Recibo atualizado (root).');
    } catch {
      showToast('Falha ao atualizar recibo.');
    } finally {
      setBusy(false);
    }
  };

  const deleteLockedReceipt = async () => {
    if (!activeReceipt || !isRoot) return;
    setShowConfirmDelete(false);
    setBusy(true);
    try {
      await apiDelete(`/api/documents/${activeReceipt.id}`);
      setActiveReceipt(null);
      await loadAll();
      goDashboard(true);
      showToast('Recibo excluído.');
    } catch {
      showToast('Falha ao excluir recibo.');
    } finally {
      setBusy(false);
    }
  };

  const execFmt = (cmd: string, arg?: string) => {
    document.execCommand(cmd, false, arg);
    contentEditableRef.current?.focus();
    const html = contentEditableRef.current?.innerHTML || '';
    setEditorHtml(html);
  };

  const goDashboard = (force = false) => {
    if (!force && dirty && !confirm('Você tem alterações não salvas. Deseja descartar?')) return;
    setView('dashboard');
    setActiveReceipt(null);
    setEditorHtml('');
    setOriginalHtml('');
    setEditMode(false);
  };

  if (loading) {
    return <div className={styles.loadingState}>Carregando dados…</div>;
  }

  // ─── EDITOR / VIEWER MODE ───
  if (view === 'master' || view === 'receipt') {
    const isMaster = view === 'master';
    const isLockedDoc = !!activeReceipt;
    const canEdit = isMaster || !isLockedDoc || isRoot;
    const isEditing = editMode && canEdit;

    let title = 'Modelo de Recibo';
    if (view === 'receipt') {
      title = tenant
        ? `Recibo — ${tenant.full_name}${selectedMonth ? ` (${monthLabel(selectedMonth)})` : ''}`
        : 'Recibo';
    }
    const badge = isMaster ? 'Modelo Mestre' : isLockedDoc ? 'Arquivado' : 'Pré-visualização';

    return (
      <div className={styles.container}>
        <div className={styles.toolbar}>
          <button className={styles.backBtn} onClick={() => goDashboard()}>
            <ArrowLeft size={16} /> Voltar
          </button>
          <span className={styles.toolbarTitle}>{title}</span>
          <span className={styles.toolbarBadge}>{badge}</span>

          {isLockedDoc && (
            <span className={styles.lockBadge} title={isRoot ? 'Admin root pode editar/excluir' : 'Recibo arquivado'}>
              <Lock size={12} />
              {isRoot ? 'Root' : 'Protegido'}
            </span>
          )}
          {dirty && <span className={styles.dirtyBadge}><AlertTriangle size={12} /> Não salvo</span>}

          <div className={styles.toolbarSpacer} />

          {canEdit && !isEditing && (
            <button className={styles.toolBtn} onClick={() => setEditMode(true)}>
              <Pencil size={15} /> Editar
            </button>
          )}
          {isEditing && (
            <button className={styles.toolBtn} onClick={() => setEditMode(false)}>
              <Eye size={15} /> Visualizar
            </button>
          )}

          {isEditing && isMaster && (
            <button className={styles.toolBtnPrimary} onClick={() => void saveMasterTemplate()} disabled={!dirty || busy}>
              <Save size={15} /> Salvar Modelo
            </button>
          )}
          {isEditing && view === 'receipt' && !isLockedDoc && (
            <button className={styles.toolBtnPrimary} onClick={() => setShowConfirmGenerate(true)} disabled={!tenant || busy}>
              <Receipt size={15} /> Salvar Recibo
            </button>
          )}
          {isEditing && view === 'receipt' && isLockedDoc && isRoot && (
            <>
              <button className={styles.toolBtnPrimary} onClick={() => void updateLockedReceipt()} disabled={!dirty || busy}>
                <Save size={15} /> Salvar Edição
              </button>
              <button className={styles.toolBtnDanger} onClick={() => setShowConfirmDelete(true)} disabled={busy}>
                <Trash2 size={15} /> Excluir
              </button>
            </>
          )}

          <div className={styles.toolbarGroup}>
            <div className={styles.zoomGroup}>
              <button className={styles.zoomBtn} onClick={zoomOut}><ZoomOut size={14} /></button>
              <span className={styles.zoomLevel}>{zoom}%</span>
              <button className={styles.zoomBtn} onClick={zoomIn}><ZoomIn size={14} /></button>
            </div>
            <button className={styles.toolBtn} onClick={handlePrint}><Printer size={15} /> Imprimir</button>
            <button className={styles.toolBtn} onClick={() => void handleDownloadPDF()}><Download size={15} /> PDF</button>
          </div>
        </div>

        {isEditing && (
          <div className={styles.formatBar}>
            <button className={styles.fmtBtn} onMouseDown={(e) => { e.preventDefault(); execFmt('bold'); }} title="Negrito"><Bold size={14} /></button>
            <button className={styles.fmtBtn} onMouseDown={(e) => { e.preventDefault(); execFmt('italic'); }} title="Itálico"><Italic size={14} /></button>
            <button className={styles.fmtBtn} onMouseDown={(e) => { e.preventDefault(); execFmt('underline'); }} title="Sublinhado"><Underline size={14} /></button>
            <span className={styles.fmtSep} />
            <button className={styles.fmtBtn} onMouseDown={(e) => { e.preventDefault(); execFmt('justifyLeft'); }} title="Esquerda"><AlignLeft size={14} /></button>
            <button className={styles.fmtBtn} onMouseDown={(e) => { e.preventDefault(); execFmt('justifyCenter'); }} title="Centralizar"><AlignCenter size={14} /></button>
            <button className={styles.fmtBtn} onMouseDown={(e) => { e.preventDefault(); execFmt('justifyRight'); }} title="Direita"><AlignRight size={14} /></button>
          </div>
        )}

        <div className={styles.viewer}>
          {busy ? (
            <div className={styles.loadingState}>Carregando…</div>
          ) : (
            <div className={styles.documentWrapper} style={{ transform: `scale(${zoom / 100})` }}>
              <div className={styles.document} ref={docRef}>
                {isEditing ? (
                  <div
                    ref={contentEditableRef}
                    className="oc-document-body"
                    contentEditable
                    suppressContentEditableWarning
                    onInput={() => setEditorHtml(contentEditableRef.current?.innerHTML || '')}
                    style={{ outline: 'none', minHeight: 600 }}
                  />
                ) : (
                  <div
                    className="oc-document-body"
                    dangerouslySetInnerHTML={{ __html: editorHtml }}
                  />
                )}
              </div>
            </div>
          )}
        </div>

        {showConfirmGenerate && (
          <div className={styles.modalBackdrop} onClick={() => setShowConfirmGenerate(false)}>
            <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
              <button
                className={styles.modalClose}
                onClick={() => setShowConfirmGenerate(false)}
                aria-label="Fechar"
              >
                <X size={18} />
              </button>
              <div className={styles.modalIcon}>
                <AlertTriangle size={28} />
              </div>
              <h3 className={styles.modalTitle}>Confirmar geração de recibo</h3>
              <p className={styles.modalText}>
                Após salvar, o recibo será arquivado no histórico do inquilino e não poderá mais ser
                modificado, exceto pelo administrador root.
              </p>
              <p className={styles.modalSubtext}>
                Inquilino: <strong>{tenant?.full_name}</strong>
                <br />
                Referência: <strong>{monthLabel(selectedMonth)}</strong>
              </p>
              <div className={styles.modalActions}>
                <button className={styles.modalBtnCancel} onClick={() => setShowConfirmGenerate(false)}>
                  Cancelar
                </button>
                <button className={styles.modalBtnConfirm} onClick={() => void generateReceipt()}>
                  <CheckCircle2 size={16} /> Salvar Recibo
                </button>
              </div>
            </div>
          </div>
        )}

        {showConfirmDelete && (
          <div className={styles.modalBackdrop} onClick={() => setShowConfirmDelete(false)}>
            <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
              <button
                className={styles.modalClose}
                onClick={() => setShowConfirmDelete(false)}
                aria-label="Fechar"
              >
                <X size={18} />
              </button>
              <div className={`${styles.modalIcon} ${styles.modalIconDanger}`}>
                <Trash2 size={28} />
              </div>
              <h3 className={styles.modalTitle}>Excluir recibo?</h3>
              <p className={styles.modalText}>
                Esta ação removerá o recibo do histórico de{' '}
                <strong>{tenant?.full_name}</strong>.
              </p>
              <div className={styles.modalActions}>
                <button className={styles.modalBtnCancel} onClick={() => setShowConfirmDelete(false)}>
                  Cancelar
                </button>
                <button className={styles.modalBtnDanger} onClick={() => void deleteLockedReceipt()}>
                  <Trash2 size={16} /> Excluir
                </button>
              </div>
            </div>
          </div>
        )}

        {toast && (
          <div className={styles.toast}>
            <FileText size={16} /> {toast}
          </div>
        )}
      </div>
    );
  }

  // ─── DASHBOARD VIEW ───
  return (
    <div className={styles.dashContainer}>
      <header className={styles.dashHeader}>
        <div className={styles.dashHeaderLeft}>
          <Link href="/documents" className={styles.backBtn}>
            <ArrowLeft size={16} /> Documentos
          </Link>
          <div>
            <h2 className={styles.dashTitle}>Recibos de Pagamento</h2>
            <p className={styles.dashDesc}>
              Edite o modelo mestre, gere e arquive recibos profissionais para seus inquilinos.
            </p>
          </div>
        </div>
      </header>

      <div className={styles.statsRow}>
        <div className={styles.statCard}>
          <div className={`${styles.statIcon} ${styles.statIconTenants}`}><Users size={20} /></div>
          <div>
            <div className={styles.statValue}>{tenants.length}</div>
            <div className={styles.statLabel}>Inquilinos</div>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={`${styles.statIcon} ${styles.statIconPaid}`}><Receipt size={20} /></div>
          <div>
            <div className={styles.statValue}>{allReceipts.length}</div>
            <div className={styles.statLabel}>Recibos arquivados</div>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={`${styles.statIcon} ${styles.statIconMonth}`}><Calendar size={20} /></div>
          <div>
            <div className={styles.statValue}>{monthLabel(selectedMonth || availableMonths[0])}</div>
            <div className={styles.statLabel}>Mês selecionado</div>
          </div>
        </div>
      </div>

      {/* MASTER TEMPLATE BUTTON */}
      <button className={styles.masterCard} onClick={openMasterEditor}>
        <div className={styles.masterIcon}><Pencil size={22} /></div>
        <div className={styles.masterText}>
          <h3 className={styles.masterTitle}>Editar Modelo Mestre de Recibo</h3>
          <p className={styles.masterDesc}>
            Visualize e edite o modelo usado para gerar todos os recibos.
          </p>
        </div>
      </button>

      <div className={styles.generatorSection}>
        <div className={styles.generatorCard}>
          <h3 className={styles.generatorTitle}>Gerar Recibo</h3>
          <p className={styles.generatorDesc}>
            Selecione o inquilino e o mês de referência para gerar o recibo.
          </p>

          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Inquilino</label>
            <select
              className={styles.select}
              value={selectedTenantId}
              onChange={(e) => setSelectedTenantId(e.target.value)}
            >
              {tenants.map((t) => (
                <option key={t.id} value={String(t.id)}>
                  {t.full_name} {t.unit_number ? `— Unidade ${t.unit_number}` : ''}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Mês de Referência</label>
            <select
              className={styles.select}
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
            >
              {availableMonths.map((m) => (
                <option key={m} value={m}>{monthLabel(m)}</option>
              ))}
            </select>
          </div>

          {payment && (
            <div className={styles.paymentPreview}>
              <div className={styles.previewRow}>
                <span>Valor:</span>
                <strong>{formatMoneyBR(payment.amount)}</strong>
              </div>
              {payment.late_fee > 0 && (
                <div className={styles.previewRow}>
                  <span>Multa:</span>
                  <strong>{formatMoneyBR(payment.late_fee)}</strong>
                </div>
              )}
              <div className={styles.previewRow}>
                <span>Status:</span>
                <span className={payment.status === 'paid' ? styles.previewPaid : styles.previewPending}>
                  {payment.status === 'paid' ? 'Pago' : 'Pendente'}
                </span>
              </div>
              {payment.paid_at && (
                <div className={styles.previewRow}>
                  <span>Pago em:</span>
                  <span>{formatDateBR(payment.paid_at)}</span>
                </div>
              )}
            </div>
          )}

          {!payment && selectedTenantId && (
            <div className={styles.noPayment}>
              Nenhum pagamento registrado para este mês. O recibo será gerado com os dados base do contrato.
            </div>
          )}

          <button className={styles.generateBtn} onClick={openReceiptPreview} disabled={!tenant}>
            <Receipt size={18} />
            Visualizar Recibo
          </button>
        </div>

        <div className={styles.recentCard}>
          <h3 className={styles.generatorTitle}>Pagamentos Recentes</h3>
          <p className={styles.generatorDesc}>
            {tenant ? `Histórico de pagamentos de ${tenant.full_name}` : 'Selecione um inquilino'}
          </p>
          <div className={styles.recentList}>
            {tenantPayments.length === 0 && (
              <div className={styles.emptyList}>Nenhum pagamento encontrado.</div>
            )}
            {tenantPayments.slice(0, 8).map((p) => (
              <div key={p.id} className={styles.recentItem}>
                <div>
                  <div className={styles.recentMonth}>{monthLabel(p.month)}</div>
                  <div className={styles.recentDate}>{p.paid_at ? formatDateBR(p.paid_at) : '—'}</div>
                </div>
                <div className={styles.recentAmount}>{formatMoneyBR(p.amount + p.late_fee)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* RECEIPT HISTORY */}
      <div className={styles.historySection}>
        <div className={styles.historyHeader}>
          <div>
            <h3 className={styles.historyTitle}>
              <History size={18} /> Histórico de Recibos
            </h3>
            <p className={styles.generatorDesc}>
              {tenant
                ? `${tenantReceipts.length} recibo(s) arquivado(s) para ${tenant.full_name}`
                : `${allReceipts.length} recibo(s) arquivado(s) no total`}
            </p>
          </div>
        </div>
        <div className={styles.historyList}>
          {(tenant ? tenantReceipts : allReceipts).length === 0 && (
            <div className={styles.emptyList}>
              Nenhum recibo gerado ainda. Use o botão acima para gerar o primeiro.
            </div>
          )}
          {(tenant ? tenantReceipts : allReceipts).slice(0, 30).map((r) => (
            <button
              key={r.id}
              className={styles.historyRow}
              onClick={() => void openExistingReceipt(r.id)}
            >
              <div className={styles.historyIcon}><Receipt size={16} /></div>
              <div className={styles.historyInfo}>
                <div className={styles.historyName}>
                  {r.tenant_name}
                  {r.reference_month ? ` — ${monthLabel(r.reference_month)}` : ''}
                </div>
                <div className={styles.historyMeta}>
                  Gerado em {formatDateBR(r.generated_at)}
                </div>
              </div>
              {r.is_locked && <Lock size={14} className={styles.historyLock} />}
            </button>
          ))}
        </div>
      </div>

      {toast && (
        <div className={styles.toast}>
          <FileText size={16} /> {toast}
        </div>
      )}
    </div>
  );
}
