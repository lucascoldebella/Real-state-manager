'use client';
/* eslint-disable @next/next/no-img-element */

import React from 'react';
import { apiPublicPost } from '../../lib/api';
import styles from './page.module.css';

interface FormState {
  full_name: string;
  cpf: string;
  rg: string;
  civil_state: string;
  occupation: string;
  reference_address: string;
  phone: string;
  email: string;
  due_day: number;
  contract_months: number;
  doc_front_image: string;
  doc_back_image: string;
}

const INITIAL_FORM: FormState = {
  full_name: '',
  cpf: '',
  rg: '',
  civil_state: '',
  occupation: '',
  reference_address: '',
  phone: '',
  email: '',
  due_day: 0,
  contract_months: 6,
  doc_front_image: '',
  doc_back_image: '',
};

const TOTAL_STEPS = 10;

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

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Falha ao ler imagem'));
    };
    reader.onerror = () => reject(new Error('Falha ao ler imagem'));
    reader.readAsDataURL(file);
  });
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Falha ao carregar imagem'));
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

export default function PreRegisterPage() {
  const [step, setStep] = React.useState(0);
  const [form, setForm] = React.useState<FormState>(INITIAL_FORM);
  const [loading, setLoading] = React.useState(false);
  const [erro, setErro] = React.useState('');
  const [sucesso, setSucesso] = React.useState(false);
  const [mostrarPopper, setMostrarPopper] = React.useState(false);
  const popperTimerRef = React.useRef<number | null>(null);

  const progresso = Math.min(100, Math.max(0, (step / TOTAL_STEPS) * 100));

  React.useEffect(
    () => () => {
      if (popperTimerRef.current) {
        window.clearTimeout(popperTimerRef.current);
      }
    },
    [],
  );

  const podeAvancar = React.useMemo(() => {
    switch (step) {
      case 0:
        return true;
      case 1:
        return form.full_name.trim().length > 4;
      case 2:
        return form.cpf.replace(/\D/g, '').length === 11 && form.rg.replace(/\D/g, '').length > 0;
      case 3:
        return form.civil_state.trim().length > 0;
      case 4:
        return form.occupation.trim().length > 0;
      case 5:
        return form.reference_address.trim().length > 5;
      case 6:
        return form.phone.replace(/\D/g, '').length >= 10;
      case 7:
        return form.email.includes('@');
      case 8:
        return [5, 10, 15, 20].includes(form.due_day);
      case 9:
        return form.contract_months >= 1 && form.contract_months <= 12;
      default:
        return false;
    }
  }, [form, step]);

  const avancar = () => {
    if (!podeAvancar) return;
    setErro('');
    setStep((prev) => Math.min(TOTAL_STEPS, prev + 1));
  };

  const voltar = () => {
    setErro('');
    setStep((prev) => Math.max(0, prev - 1));
  };

  const onImage = async (side: 'front' | 'back', file: File) => {
    try {
      const raw = await fileToDataUrl(file);
      const image = await resizeDataUrl(raw, 1400);
      setForm((prev) => ({
        ...prev,
        doc_front_image: side === 'front' ? image : prev.doc_front_image,
        doc_back_image: side === 'back' ? image : prev.doc_back_image,
      }));
    } catch (err) {
      setErro(err instanceof Error ? err.message : 'Erro ao carregar imagem');
    }
  };

  const finalizar = async () => {
    setErro('');
    if (!form.doc_front_image || !form.doc_back_image) {
      setErro('Envie as fotos frente e verso do documento.');
      return;
    }

    setLoading(true);
    try {
      await apiPublicPost('/api/pre-register', {
        full_name: form.full_name.trim(),
        cpf: form.cpf.replace(/\D/g, ''),
        rg: form.rg.replace(/\D/g, ''),
        civil_state: form.civil_state.trim(),
        occupation: form.occupation.trim(),
        reference_address: form.reference_address.trim(),
        phone: form.phone.replace(/\D/g, ''),
        email: form.email.trim(),
        due_day: form.due_day,
        contract_months: form.contract_months,
        doc_front_image: form.doc_front_image,
        doc_back_image: form.doc_back_image,
      });

      setSucesso(true);
      setMostrarPopper(true);
      if (popperTimerRef.current) window.clearTimeout(popperTimerRef.current);
      popperTimerRef.current = window.setTimeout(() => setMostrarPopper(false), 1200);
      setStep(TOTAL_STEPS + 1);
    } catch (err) {
      setErro(err instanceof Error ? err.message : 'Não foi possível finalizar agora.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>OC Negócios imobiliários</header>

      {step > 0 && step <= TOTAL_STEPS && (
        <div className={styles.progressWrap}>
          <div className={styles.progress} style={{ width: `${progresso}%` }}></div>
        </div>
      )}

      <section className={styles.card}>
        <div key={step} className={styles.stepPanel}>
          {step === 0 && (
            <div className={styles.centerStep}>
              <p className={styles.welcomeText}>
                Seja bem vindo ao seu cadastro em nossa imobiliária, este cadastro requer uma foto do seu documento, então deixe-o preparado
              </p>
            </div>
          )}

          {step === 1 && (
            <div className={styles.stepBody}>
              <h2>Nome Completo</h2>
              <p>Seu nome completo igual ao seu documento</p>
              <input
                maxLength={40}
                value={form.full_name}
                onChange={(e) => setForm((prev) => ({ ...prev, full_name: e.target.value }))}
              />
            </div>
          )}

          {step === 2 && (
            <div className={styles.stepBody}>
              <h2>Documentos</h2>
              <div className={styles.grid2}>
                <label>
                  <span>CPF</span>
                  <input
                    inputMode="numeric"
                    value={form.cpf}
                    onChange={(e) => setForm((prev) => ({ ...prev, cpf: formatCpf(e.target.value) }))}
                    placeholder="111.111.111-11"
                  />
                </label>
                <label>
                  <span>RG</span>
                  <input
                    inputMode="numeric"
                    value={form.rg}
                    onChange={(e) => setForm((prev) => ({ ...prev, rg: e.target.value.replace(/\D/g, '').slice(0, 9) }))}
                  />
                </label>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className={styles.stepBody}>
              <h2>Estado Civil</h2>
              <input
                maxLength={40}
                value={form.civil_state}
                onChange={(e) => setForm((prev) => ({ ...prev, civil_state: e.target.value }))}
              />
            </div>
          )}

          {step === 4 && (
            <div className={styles.stepBody}>
              <h2>Profissão</h2>
              <input
                maxLength={40}
                value={form.occupation}
                onChange={(e) => setForm((prev) => ({ ...prev, occupation: e.target.value }))}
              />
            </div>
          )}

          {step === 5 && (
            <div className={styles.stepBody}>
              <h2>Endereço referência</h2>
              <p>Adicione um endereço de referência, como casa dos pais ou trabalho</p>
              <textarea
                maxLength={40}
                value={form.reference_address}
                onChange={(e) => setForm((prev) => ({ ...prev, reference_address: e.target.value }))}
              />
            </div>
          )}

          {step === 6 && (
            <div className={styles.stepBody}>
              <h2>Número de telefone</h2>
              <input
                inputMode="numeric"
                value={form.phone}
                onChange={(e) => setForm((prev) => ({ ...prev, phone: formatPhone(e.target.value) }))}
                placeholder="(67)9.9999-9999"
              />
            </div>
          )}

          {step === 7 && (
            <div className={styles.stepBody}>
              <h2>Email</h2>
              <input
                type="email"
                maxLength={40}
                value={form.email}
                onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
              />
            </div>
          )}

          {step === 8 && (
            <div className={styles.stepBody}>
              <h2>Data de vencimento</h2>
              <p>Data de vencimento do aluguel</p>
              <div className={styles.dueGrid}>
                {[5, 10, 15, 20].map((day) => (
                  <button
                    type="button"
                    key={day}
                    className={`${styles.dueOption} ${form.due_day === day ? styles.selected : ''}`}
                    onClick={() => setForm((prev) => ({ ...prev, due_day: day }))}
                  >
                    {day}
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 9 && (
            <div className={styles.stepBody}>
              <h2>Tempo de contrato</h2>
              <div className={styles.monthsWrap}>
                <div className={styles.monthsValue}>{form.contract_months} meses</div>
                <input
                  className={styles.monthsSlider}
                  type="range"
                  min={1}
                  max={12}
                  step={1}
                  value={form.contract_months}
                  onChange={(e) => setForm((prev) => ({ ...prev, contract_months: Number(e.target.value) }))}
                />
                <div className={styles.sliderScale}>
                  <span>1</span>
                  <span>12</span>
                </div>
              </div>
            </div>
          )}

          {step === 10 && (
            <div className={styles.stepBody}>
              <h2>Foto do RG ou CNH frente e verso</h2>
              <div className={styles.grid2}>
                <label className={styles.uploadBox}>
                  {form.doc_front_image ? <img src={form.doc_front_image} alt="Frente" /> : <span>Frente</span>}
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void onImage('front', file);
                      e.currentTarget.value = '';
                    }}
                  />
                </label>

                <label className={styles.uploadBox}>
                  {form.doc_back_image ? <img src={form.doc_back_image} alt="Verso" /> : <span>Verso</span>}
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void onImage('back', file);
                      e.currentTarget.value = '';
                    }}
                  />
                </label>
              </div>
            </div>
          )}

          {step === TOTAL_STEPS + 1 && sucesso && (
            <div className={styles.successWrap}>
              {mostrarPopper && (
                <div className={styles.popperFx}>
                  {Array.from({ length: 24 }).map((_, idx) => (
                    <span key={idx} style={{ ['--i' as never]: idx } as React.CSSProperties}></span>
                  ))}
                </div>
              )}
              <h2>Parabéns, seu pré-cadastro foi realizado com sucesso em breve nossa equipe lhe contactará para mais detalhes</h2>
            </div>
          )}
        </div>

        {erro && <div className={styles.error}>{erro}</div>}

        {step <= TOTAL_STEPS && (
          <div className={`${styles.footerActions} ${step === 0 ? styles.footerActionsIntro : ''}`}>
            {step > 0 ? (
              <button type="button" className={styles.backBtn} onClick={voltar}>
                voltar
              </button>
            ) : (
              <div></div>
            )}

            {step < 10 && (
              <button type="button" className={step === 0 ? styles.nextBtnIntro : styles.nextBtn} onClick={avancar} disabled={!podeAvancar}>
                Próximo
              </button>
            )}

            {step === 10 && (
              <button type="button" className={styles.finishBtn} onClick={() => void finalizar()} disabled={loading}>
                {loading ? 'Enviando...' : 'Finalizar Cadastro'}
              </button>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
