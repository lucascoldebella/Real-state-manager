'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Wrench, Zap, Droplets, HelpCircle, BedDouble, FlameKindling, Refrigerator } from 'lucide-react';
import { useClientAuth } from '../../../../lib/client-auth-context';
import { clientPost } from '../../../../lib/clientApi';
import type { UploadFile } from '../../../../components/client/UploadField/UploadField';
import ClientShell from '../../../../components/client/ClientShell/ClientShell';
import Wizard from '../../../../components/client/Wizard/Wizard';
import UploadField from '../../../../components/client/UploadField/UploadField';

type Category = 'moveis' | 'eletrica' | 'hidraulica' | 'outros';
type Subcategory = 'cama' | 'fogao' | 'geladeira' | 'outros';

const CATEGORIES = [
  { value: 'moveis' as Category, label: 'Móveis', icon: Wrench, sub: true },
  { value: 'eletrica' as Category, label: 'Elétrica', icon: Zap, sub: false },
  { value: 'hidraulica' as Category, label: 'Hidráulica', icon: Droplets, sub: false },
  { value: 'outros' as Category, label: 'Outros', icon: HelpCircle, sub: false },
];

const SUBCATEGORIES = [
  { value: 'cama' as Subcategory, label: 'Cama', icon: BedDouble },
  { value: 'fogao' as Subcategory, label: 'Fogão', icon: FlameKindling },
  { value: 'geladeira' as Subcategory, label: 'Geladeira', icon: Refrigerator },
  { value: 'outros' as Subcategory, label: 'Outros', icon: HelpCircle },
];

const optionStyle = (active: boolean): React.CSSProperties => ({
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
  padding: '16px 12px', borderRadius: 'var(--radius-lg)',
  border: `2px solid ${active ? 'var(--primary)' : 'var(--border-color)'}`,
  background: active ? 'var(--primary-light)' : 'var(--bg-card)',
  color: active ? 'var(--primary-text)' : 'var(--text-muted)',
  cursor: 'pointer', fontSize: 13, fontWeight: 600,
  transition: 'all var(--transition-fast)',
});

export default function NewTicketPage() {
  const router = useRouter();
  const { isAuthenticated, loading } = useClientAuth();

  const [step, setStep] = useState(0);
  const [category, setCategory] = useState<Category | ''>('');
  const [subcategory, setSubcategory] = useState<Subcategory | ''>('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!loading && !isAuthenticated) router.replace('/client/login');
  }, [isAuthenticated, loading, router]);

  const needsSubcat = category === 'moveis';
  const totalSteps = needsSubcat ? 5 : 4;

  const canNext = (): boolean => {
    if (step === 0) return true;
    if (step === 1) return category !== '';
    if (step === 2 && needsSubcat) return subcategory !== '';
    const descStep = needsSubcat ? 3 : 2;
    if (step === descStep) return description.trim().length >= 5;
    const uploadStep = needsSubcat ? 4 : 3;
    if (step === uploadStep) return files.some(f => f.mime.startsWith('image/'));
    return true;
  };

  const handleNext = async () => {
    if (step < totalSteps - 1) { setStep(s => s + 1); return; }
    // Submit
    setSubmitting(true); setError('');
    try {
      await clientPost('/api/client/tickets', {
        category, subcategory,
        description,
        files: files.map(f => ({ name: f.name, mime: f.mime, data_b64: f.data_b64 })),
      });
      router.replace('/client/tickets');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setStep(totalSteps - 1);
    } finally { setSubmitting(false); }
  };

  const handleBack = () => setStep(s => Math.max(0, s - 1));

  if (loading) return null;

  const descStep = needsSubcat ? 3 : 2;
  const uploadStep = needsSubcat ? 4 : 3;

  return (
    <ClientShell>
      <div style={{ maxWidth: 520, margin: '0 auto' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, marginBottom: 20 }}>
          Chamado técnico
        </h1>
        <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-xl)', padding: '24px 20px', boxShadow: 'var(--shadow-card)' }}>
          <Wizard step={step} totalSteps={totalSteps} onBack={step > 0 ? handleBack : undefined} onNext={() => void handleNext()}
            nextLabel={step === totalSteps - 1 ? 'Enviar chamado' : 'Próximo'} nextDisabled={!canNext()} loading={submitting}>

            {step === 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ background: 'var(--info-bg)', borderRadius: 'var(--radius-md)', padding: '14px 16px', fontSize: 14, color: 'var(--info-text)', lineHeight: 1.6 }}>
                  Olá! Esta área é dedicada à abertura de chamados técnicos referentes ao seu imóvel.
                  Descreva o problema em detalhes e, se possível, faça boas fotos ou vídeos para que possamos repassar à nossa equipe técnica.
                </div>
              </div>
            )}

            {step === 1 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <p style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Este problema é referente à:</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {CATEGORIES.map(c => (
                    <button key={c.value} type="button" style={optionStyle(category === c.value)} onClick={() => { setCategory(c.value); setSubcategory(''); }}>
                      <c.icon size={24} />
                      <span>{c.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {step === 2 && needsSubcat && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <p style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Qual móvel está com problema?</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {SUBCATEGORIES.map(s => (
                    <button key={s.value} type="button" style={optionStyle(subcategory === s.value)} onClick={() => setSubcategory(s.value)}>
                      <s.icon size={24} />
                      <span>{s.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {step === descStep && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <label style={{ fontSize: 15, fontWeight: 600 }}>
                  Descreva o problema em detalhes para nossa equipe técnica verificar
                </label>
                <textarea
                  maxLength={256}
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={5}
                  placeholder="Descreva o problema com o máximo de detalhes possível…"
                  style={{ border: '1.5px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '12px 14px', fontSize: 14, resize: 'vertical', fontFamily: 'inherit', width: '100%', color: 'var(--text-main)', background: 'var(--bg-main)' }}
                />
                <div style={{ textAlign: 'right', fontSize: 12, color: description.length > 230 ? 'var(--warning)' : 'var(--text-muted)' }}>
                  {description.length} / 256
                </div>
              </div>
            )}

            {step === uploadStep && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p style={{ fontSize: 15, fontWeight: 600 }}>Adicione fotos ou vídeos do problema</p>
                <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: -4 }}>Pelo menos 1 foto é obrigatória.</p>
                <UploadField files={files} onChange={setFiles} max={4} requireImage />
                {error && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>}
              </div>
            )}
          </Wizard>
        </div>
      </div>
    </ClientShell>
  );
}
