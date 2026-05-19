'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useClientAuth } from '../../../../lib/client-auth-context';
import { clientPost } from '../../../../lib/clientApi';
import type { UploadFile } from '../../../../components/client/UploadField/UploadField';
import ClientShell from '../../../../components/client/ClientShell/ClientShell';
import Wizard from '../../../../components/client/Wizard/Wizard';
import UploadField from '../../../../components/client/UploadField/UploadField';

const TOTAL_STEPS = 3;

export default function NewComplaintPage() {
  const router = useRouter();
  const { isAuthenticated, loading } = useClientAuth();

  const [step, setStep] = useState(0);
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!loading && !isAuthenticated) router.replace('/client/login');
  }, [isAuthenticated, loading, router]);

  const canNext = (): boolean => {
    if (step === 0) return true;
    if (step === 1) return body.trim().length >= 10;
    return true;
  };

  const handleNext = async () => {
    if (step < TOTAL_STEPS - 1) { setStep(s => s + 1); return; }
    setSubmitting(true); setError('');
    try {
      await clientPost('/api/client/complaints', {
        body,
        files: files.map(f => ({ name: f.name, mime: f.mime, data_b64: f.data_b64 })),
      });
      router.replace('/client/dashboard');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally { setSubmitting(false); }
  };

  const handleBack = () => setStep(s => Math.max(0, s - 1));

  if (loading) return null;

  return (
    <ClientShell>
      <div style={{ maxWidth: 520, margin: '0 auto' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, marginBottom: 20 }}>
          Denúncia anônima
        </h1>
        <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-xl)', padding: '24px 20px', boxShadow: 'var(--shadow-card)' }}>
          <Wizard step={step} totalSteps={TOTAL_STEPS} onBack={step > 0 ? handleBack : undefined}
            onNext={() => void handleNext()}
            nextLabel={step === TOTAL_STEPS - 1 ? 'Enviar denúncia' : 'Próximo'}
            nextDisabled={!canNext()} loading={submitting}>

            {step === 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ background: 'var(--info-bg)', borderRadius: 'var(--radius-md)', padding: '14px 16px', fontSize: 14, color: 'var(--info-text)', lineHeight: 1.6 }}>
                  Olá! Esta sessão é dedicada à realização de denúncias anônimas referente à conduta de outros moradores.
                  Sua identidade será <strong>100% preservada</strong>.
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  Nenhuma informação que identifique você será armazenada. Use este canal com responsabilidade.
                </div>
              </div>
            )}

            {step === 1 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <label style={{ fontSize: 15, fontWeight: 600 }}>
                  Descreva a situação
                </label>
                <textarea
                  maxLength={1024}
                  value={body}
                  onChange={e => setBody(e.target.value)}
                  rows={7}
                  placeholder="Descreva o ocorrido com o máximo de detalhes possível…"
                  style={{ border: '1.5px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '12px 14px', fontSize: 14, resize: 'vertical', fontFamily: 'inherit', width: '100%', color: 'var(--text-main)', background: 'var(--bg-main)' }}
                />
                <div style={{ textAlign: 'right', fontSize: 12, color: body.length > 900 ? 'var(--warning)' : 'var(--text-muted)' }}>
                  {body.length} / 1024
                </div>
              </div>
            )}

            {step === 2 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p style={{ fontSize: 15, fontWeight: 600 }}>Fotos ou vídeos (opcional)</p>
                <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: -4 }}>
                  Adicione evidências se desejar. Não é obrigatório.
                </p>
                <UploadField files={files} onChange={setFiles} max={4} />
                {error && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>}
              </div>
            )}
          </Wizard>
        </div>
      </div>
    </ClientShell>
  );
}
