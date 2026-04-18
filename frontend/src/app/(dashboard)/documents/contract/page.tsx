'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Download,
  Printer,
  ZoomIn,
  ZoomOut,
  FileText,
  Users,
  Clock,
  Lock,
  Shield,
  Eye,
  Pencil,
  Save,
  AlertTriangle,
  Trash2,
  CheckCircle2,
  X,
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  AlignLeft,
  AlignCenter,
  AlignRight,
} from 'lucide-react';
import { apiGet, apiPost, apiPut, apiDelete, getStoredUser } from '../../../../lib/api';
import type { Tenant, DocumentItem, DocumentTemplate } from '../../../../lib/types';
import {
  formatDateBR,
  buildContractPlaceholders,
  applyPlaceholders,
} from '../../../../lib/document-helpers';
import styles from './page.module.css';

type ViewMode = 'dashboard' | 'master' | 'tenant';

export default function ContractViewerPage() {
  const searchParams = useSearchParams();
  const initialTenantId = searchParams.get('tenantId');

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [masterTemplate, setMasterTemplate] = useState<DocumentTemplate | null>(null);

  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState(initialTenantId || '');

  const [tenantDoc, setTenantDoc] = useState<DocumentItem | null>(null);
  const [editorHtml, setEditorHtml] = useState<string>('');
  const [originalHtml, setOriginalHtml] = useState<string>('');

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [toast, setToast] = useState('');
  const [view, setView] = useState<ViewMode>(initialTenantId ? 'tenant' : 'dashboard');
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

  const user = getStoredUser();
  const isRoot = user?.is_root === true;

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [tenantsRes, docsRes, templatesRes] = await Promise.all([
        apiGet<{ items: Tenant[] }>('/api/tenants'),
        apiGet<{ items: DocumentItem[] }>('/api/documents'),
        apiGet<{ items: DocumentTemplate[] }>('/api/document-templates'),
      ]);
      const active = (tenantsRes.items || []).filter((t) => t.active);
      setTenants(active);
      setDocuments((docsRes.items || []).filter((d) => d.document_type === 'rental_contract'));
      const master = (templatesRes.items || []).find((t) => t.document_type === 'rental_contract_master') || null;
      setMasterTemplate(master);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!initialTenantId || tenants.length === 0) return;
    const found = tenants.find((t) => t.id === Number(initialTenantId));
    if (found) {
      void openTenantViewer(found.id.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenants, initialTenantId]);

  const expiringContracts = useMemo(
    () =>
      tenants.filter((t) => {
        if (!t.contract_end) return false;
        const end = new Date(t.contract_end);
        const diff = (end.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
        return diff >= 0 && diff <= 30;
      }).length,
    [tenants],
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
      ? 'Contrato_Modelo'
      : tenant
        ? `Contrato_${tenant.full_name.replace(/\s+/g, '_')}`
        : 'Contrato';
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

  const openMasterEditor = () => {
    if (!masterTemplate) {
      showToast('Modelo mestre não encontrado.');
      return;
    }
    setEditorHtml(masterTemplate.template_body);
    setOriginalHtml(masterTemplate.template_body);
    setEditMode(true);
    setView('master');
  };

  const openTenantViewer = useCallback(
    async (tenantId: string) => {
      const found = tenants.find((t) => t.id === Number(tenantId));
      if (!found) return;
      setTenant(found);
      setSelectedTenantId(tenantId);
      setEditMode(false);
      setView('tenant');
      setBusy(true);
      try {
        const list = await apiGet<{ items: DocumentItem[] }>(`/api/documents?tenant_id=${found.id}`);
        const existingMeta = (list.items || []).find((d) => d.document_type === 'rental_contract');
        if (existingMeta) {
          const full = await apiGet<DocumentItem>(`/api/documents/${existingMeta.id}`);
          setTenantDoc(full);
          setEditorHtml(full.content_html || '');
          setOriginalHtml(full.content_html || '');
        } else {
          setTenantDoc(null);
          const tpl = masterTemplate?.template_body || '';
          const placeholders = buildContractPlaceholders(found);
          const filled = applyPlaceholders(tpl, placeholders);
          setEditorHtml(filled);
          setOriginalHtml(filled);
        }
      } catch {
        showToast('Falha ao carregar contrato.');
      } finally {
        setBusy(false);
      }
    },
    [tenants, masterTemplate, showToast],
  );

  const dirty = editorHtml !== originalHtml;

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
      showToast('Modelo salvo com sucesso!');
    } catch {
      showToast('Falha ao salvar modelo.');
    } finally {
      setBusy(false);
    }
  };

  const generateContract = async () => {
    if (!tenant) return;
    setShowConfirmGenerate(false);
    setBusy(true);
    try {
      const res = await apiPost<{ id: number; message: string }>('/api/documents/save', {
        tenant_id: tenant.id,
        document_type: 'rental_contract',
        content_html: editorHtml,
      });
      const full = await apiGet<DocumentItem>(`/api/documents/${res.id}`);
      setTenantDoc(full);
      setOriginalHtml(full.content_html || '');
      setEditorHtml(full.content_html || '');
      await loadAll();
      showToast('Contrato gerado e protegido!');
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('contract_already_exists_for_tenant')) {
        showToast('Já existe um contrato para este inquilino.');
      } else {
        showToast('Falha ao gerar contrato.');
      }
    } finally {
      setBusy(false);
    }
  };

  const updateLockedContract = async () => {
    if (!tenantDoc || !isRoot || !dirty) return;
    setBusy(true);
    try {
      await apiPut(`/api/documents/${tenantDoc.id}`, { content_html: editorHtml });
      setOriginalHtml(editorHtml);
      showToast('Contrato atualizado (root).');
    } catch {
      showToast('Falha ao atualizar contrato.');
    } finally {
      setBusy(false);
    }
  };

  const deleteLockedContract = async () => {
    if (!tenantDoc || !isRoot) return;
    setShowConfirmDelete(false);
    setBusy(true);
    try {
      await apiDelete(`/api/documents/${tenantDoc.id}`);
      setTenantDoc(null);
      const tpl = masterTemplate?.template_body || '';
      const placeholders = tenant ? buildContractPlaceholders(tenant) : {};
      const filled = applyPlaceholders(tpl, placeholders);
      setEditorHtml(filled);
      setOriginalHtml(filled);
      await loadAll();
      showToast('Contrato excluído.');
    } catch {
      showToast('Falha ao excluir contrato.');
    } finally {
      setBusy(false);
    }
  };

  const goDashboard = () => {
    if (dirty && !confirm('Você tem alterações não salvas. Deseja descartar?')) return;
    setView('dashboard');
    setTenant(null);
    setTenantDoc(null);
    setEditorHtml('');
    setOriginalHtml('');
    setSelectedTenantId('');
    setEditMode(false);
  };

  const execFmt = (cmd: string, arg?: string) => {
    document.execCommand(cmd, false, arg);
    contentEditableRef.current?.focus();
    const html = contentEditableRef.current?.innerHTML || '';
    setEditorHtml(html);
  };

  const tenantHasContract = (tenantId: number) =>
    documents.some((d) => d.tenant_id === tenantId);

  // ─── EDITOR / VIEWER MODE ───
  if (view === 'master' || view === 'tenant') {
    const isMaster = view === 'master';
    const isLockedDoc = !!tenantDoc;
    const canEdit = isMaster || !isLockedDoc || isRoot;
    const isEditing = editMode && canEdit;

    let title = 'Modelo de Contrato';
    if (view === 'tenant' && tenant) title = `Contrato — ${tenant.full_name}`;
    const badge = isMaster ? 'Modelo Mestre' : isLockedDoc ? 'Gerado' : 'Pré-visualização';

    return (
      <div className={styles.container}>
        {/* ── MAIN TOOLBAR ── */}
        <div className={styles.toolbar}>
          <button className={styles.backBtn} onClick={goDashboard}>
            <ArrowLeft size={16} /> Voltar
          </button>
          <span className={styles.toolbarTitle}>{title}</span>
          <span className={styles.toolbarBadge}>{badge}</span>

          {isLockedDoc && (
            <span className={styles.lockBadge} title={isRoot ? 'Admin root pode editar/excluir' : 'Contrato vinculado ao inquilino'}>
              <Lock size={12} />
              {isRoot ? 'Root' : 'Protegido'}
            </span>
          )}
          {dirty && <span className={styles.dirtyBadge}><AlertTriangle size={12} /> Não salvo</span>}

          <div className={styles.toolbarSpacer} />

          {/* Edit toggle */}
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

          {/* Save / Generate */}
          {isEditing && isMaster && (
            <button className={styles.toolBtnPrimary} onClick={() => void saveMasterTemplate()} disabled={!dirty || busy}>
              <Save size={15} /> Salvar Modelo
            </button>
          )}
          {isEditing && view === 'tenant' && !isLockedDoc && (
            <button className={styles.toolBtnPrimary} onClick={() => setShowConfirmGenerate(true)} disabled={!tenant || busy}>
              <FileText size={15} /> Gerar Contrato
            </button>
          )}
          {isEditing && view === 'tenant' && isLockedDoc && isRoot && (
            <>
              <button className={styles.toolBtnPrimary} onClick={() => void updateLockedContract()} disabled={!dirty || busy}>
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

        {/* ── FORMAT BAR (only when editing, outside the document paper) ── */}
        {isEditing && (
          <div className={styles.formatBar}>
            <button className={styles.fmtBtn} onMouseDown={(e) => { e.preventDefault(); execFmt('bold'); }} title="Negrito"><Bold size={14} /></button>
            <button className={styles.fmtBtn} onMouseDown={(e) => { e.preventDefault(); execFmt('italic'); }} title="Itálico"><Italic size={14} /></button>
            <button className={styles.fmtBtn} onMouseDown={(e) => { e.preventDefault(); execFmt('underline'); }} title="Sublinhado"><Underline size={14} /></button>
            <span className={styles.fmtSep} />
            <button className={styles.fmtBtn} onMouseDown={(e) => { e.preventDefault(); execFmt('insertUnorderedList'); }} title="Lista"><List size={14} /></button>
            <button className={styles.fmtBtn} onMouseDown={(e) => { e.preventDefault(); execFmt('insertOrderedList'); }} title="Lista numerada"><ListOrdered size={14} /></button>
            <span className={styles.fmtSep} />
            <button className={styles.fmtBtn} onMouseDown={(e) => { e.preventDefault(); execFmt('justifyLeft'); }} title="Esquerda"><AlignLeft size={14} /></button>
            <button className={styles.fmtBtn} onMouseDown={(e) => { e.preventDefault(); execFmt('justifyCenter'); }} title="Centralizar"><AlignCenter size={14} /></button>
            <button className={styles.fmtBtn} onMouseDown={(e) => { e.preventDefault(); execFmt('justifyRight'); }} title="Direita"><AlignRight size={14} /></button>
            <span className={styles.fmtSep} />
            <button className={styles.fmtBtn} onMouseDown={(e) => { e.preventDefault(); execFmt('formatBlock', 'H2'); }} title="Título" style={{ fontWeight: 700, fontSize: 12 }}>H2</button>
            <button className={styles.fmtBtn} onMouseDown={(e) => { e.preventDefault(); execFmt('formatBlock', 'P'); }} title="Parágrafo" style={{ fontWeight: 600, fontSize: 12 }}>P</button>
          </div>
        )}

        {/* ── VIEWER ── */}
        <div className={styles.viewer}>
          {loading || busy ? (
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
                    style={{ outline: 'none', minHeight: 800 }}
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

        {/* Confirm generate modal */}
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
              <h3 className={styles.modalTitle}>Confirmar geração de contrato</h3>
              <p className={styles.modalText}>
                Após gerar o contrato o mesmo não poderá mais ser modificado, exceto pelo administrador root.
              </p>
              <p className={styles.modalSubtext}>
                Inquilino: <strong>{tenant?.full_name}</strong>
              </p>
              <div className={styles.modalActions}>
                <button className={styles.modalBtnCancel} onClick={() => setShowConfirmGenerate(false)}>
                  Cancelar
                </button>
                <button className={styles.modalBtnConfirm} onClick={() => void generateContract()}>
                  <CheckCircle2 size={16} /> Gerar e Proteger
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Confirm delete modal */}
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
              <h3 className={styles.modalTitle}>Excluir contrato?</h3>
              <p className={styles.modalText}>
                Esta ação removerá permanentemente o contrato gerado para{' '}
                <strong>{tenant?.full_name}</strong>. O inquilino poderá receber um novo contrato em seguida.
              </p>
              <div className={styles.modalActions}>
                <button className={styles.modalBtnCancel} onClick={() => setShowConfirmDelete(false)}>
                  Cancelar
                </button>
                <button className={styles.modalBtnDanger} onClick={() => void deleteLockedContract()}>
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
            <h2 className={styles.dashTitle}>Contratos de Locação</h2>
            <p className={styles.dashDesc}>
              Edite o modelo mestre e gere contratos protegidos para cada inquilino.
            </p>
          </div>
        </div>
      </header>

      {/* STATS */}
      <div className={styles.statsRow}>
        <div className={styles.statCard}>
          <div className={`${styles.statIcon} ${styles.statIconTenants}`}><Users size={20} /></div>
          <div>
            <div className={styles.statValue}>{tenants.length}</div>
            <div className={styles.statLabel}>Inquilinos ativos</div>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={`${styles.statIcon} ${styles.statIconDocs}`}><FileText size={20} /></div>
          <div>
            <div className={styles.statValue}>{documents.length}</div>
            <div className={styles.statLabel}>Contratos gerados</div>
          </div>
        </div>
        {expiringContracts > 0 && (
          <div className={styles.statCard}>
            <div className={`${styles.statIcon} ${styles.statIconWarning}`}><Clock size={20} /></div>
            <div>
              <div className={styles.statValue}>{expiringContracts}</div>
              <div className={styles.statLabel}>Vencendo em 30 dias</div>
            </div>
          </div>
        )}
        <div className={styles.statCard}>
          <div className={`${styles.statIcon} ${styles.statIconLock}`}><Shield size={20} /></div>
          <div>
            <div className={styles.statValue}>{isRoot ? 'Root' : 'Padrão'}</div>
            <div className={styles.statLabel}>{isRoot ? 'Edição liberada' : 'Contratos protegidos'}</div>
          </div>
        </div>
      </div>

      {/* ACTIONS GRID */}
      <div className={styles.actionsGrid}>
        <button className={styles.actionCard} onClick={openMasterEditor}>
          <div className={`${styles.actionIcon} ${styles.actionIconTemplate}`}>
            <Pencil size={24} />
          </div>
          <h3 className={styles.actionTitle}>Editar Modelo Mestre</h3>
          <p className={styles.actionDesc}>
            Visualize e edite o modelo de contrato usado para gerar todos os contratos dos inquilinos.
          </p>
        </button>

        <div className={styles.generateCard}>
          <h3 className={styles.generateTitle}>Gerar Contrato para Inquilino</h3>
          <p className={styles.generateDesc}>
            Selecione um inquilino para preencher o modelo automaticamente.
          </p>
          <select
            className={styles.select}
            value={selectedTenantId}
            onChange={(e) => setSelectedTenantId(e.target.value)}
          >
            <option value="">Selecione o inquilino…</option>
            {tenants.map((t) => (
              <option key={t.id} value={String(t.id)}>
                {t.full_name} {t.unit_number ? `— Un. ${t.unit_number}` : ''}
                {tenantHasContract(t.id) ? ' (contrato existente)' : ''}
              </option>
            ))}
          </select>
          <button
            className={styles.generateBtn}
            disabled={!selectedTenantId}
            onClick={() => void openTenantViewer(selectedTenantId)}
          >
            <Eye size={18} />
            Abrir Editor
          </button>
        </div>
      </div>

      {/* TENANTS WITH CONTRACTS */}
      <div className={styles.tenantsSection}>
        <h3 className={styles.sectionTitle}>Inquilinos e Contratos</h3>
        <div className={styles.tenantsList}>
          {tenants.map((t) => {
            const daysLeft = t.contract_end
              ? Math.round((new Date(t.contract_end).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
              : null;
            const isExpiring = daysLeft !== null && daysLeft >= 0 && daysLeft <= 30;
            const isExpired = daysLeft !== null && daysLeft < 0;
            const hasContract = tenantHasContract(t.id);

            return (
              <button
                key={t.id}
                className={styles.tenantRow}
                onClick={() => void openTenantViewer(String(t.id))}
              >
                <div className={styles.tenantInfo}>
                  <span className={styles.tenantName}>{t.full_name}</span>
                  <span className={styles.tenantUnit}>
                    Un. {t.unit_number || '—'} — R$ {t.rent_amount.toFixed(2).replace('.', ',')}
                  </span>
                </div>
                <div className={styles.tenantContract}>
                  {t.contract_start && t.contract_end ? (
                    <>
                      <span className={styles.tenantDates}>
                        {formatDateBR(t.contract_start)} – {formatDateBR(t.contract_end)}
                      </span>
                      <span
                        className={`${styles.tenantStatus} ${
                          isExpired
                            ? styles.statusExpired
                            : isExpiring
                              ? styles.statusExpiring
                              : styles.statusActive
                        }`}
                      >
                        {isExpired ? 'Vencido' : isExpiring ? `${daysLeft}d restantes` : 'Ativo'}
                      </span>
                    </>
                  ) : (
                    <span className={styles.tenantDates}>Sem prazo definido</span>
                  )}
                </div>
                {hasContract ? (
                  <Lock size={14} className={styles.tenantLock} />
                ) : (
                  <FileText size={14} className={styles.tenantPending} />
                )}
              </button>
            );
          })}
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
