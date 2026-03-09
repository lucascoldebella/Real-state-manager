'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Download, Printer, ZoomIn, ZoomOut, FileText } from 'lucide-react';
import { apiGet } from '../../../../lib/api';
import type { Tenant } from '../../../../lib/types';
import styles from './page.module.css';

const numberToPortuguese = (n: number): string => {
  if (n === 0) return 'zero';
  const units = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove',
    'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
  const tens = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
  const hundreds = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos',
    'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

  if (n === 100) return 'cem';

  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const remainder = n % 100;

  if (h > 0) parts.push(hundreds[h]);
  if (remainder > 0 && remainder < 20) {
    parts.push(units[remainder]);
  } else if (remainder >= 20) {
    const t = Math.floor(remainder / 10);
    const u = remainder % 10;
    parts.push(u > 0 ? `${tens[t]} e ${units[u]}` : tens[t]);
  }
  return parts.join(' e ');
};

const formatRentExtended = (value: number): string => {
  const intPart = Math.floor(value);
  const cents = Math.round((value - intPart) * 100);
  let result = numberToPortuguese(intPart) + ' reais';
  if (cents > 0) result += ` e ${numberToPortuguese(cents)} centavos`;
  return result;
};

const formatDateBR = (isoDate: string): string => {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString('pt-BR');
};

const monthsBetween = (start: string, end: string): number => {
  const s = new Date(start);
  const e = new Date(end);
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24 * 30)));
};

const todayBR = (): string => {
  const d = new Date();
  const months = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  return `${d.getDate()} de ${months[d.getMonth()]} de ${d.getFullYear()}`;
};

export default function ContractViewerPage() {
  const searchParams = useSearchParams();
  const tenantId = searchParams.get('tenantId');
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(!!tenantId);
  const [zoom, setZoom] = useState(100);
  const [toast, setToast] = useState('');
  const docRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!tenantId) return;
    (async () => {
      try {
        const res = await apiGet<{ items: Tenant[] }>('/api/tenants');
        const found = (res.items || []).find(t => t.id === Number(tenantId));
        if (found) setTenant(found);
      } catch {
        /* tenant not found */
      } finally {
        setLoading(false);
      }
    })();
  }, [tenantId]);

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
    const filename = tenant
      ? `Contrato_${tenant.full_name.replace(/\s+/g, '_')}.pdf`
      : 'Contrato_Modelo.pdf';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (html2pdf() as any).set({
      margin: 0,
      filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['avoid-all', 'css', 'legacy'] },
    }).from(el).save().then(() => showToast('PDF salvo com sucesso!'));
  };

  const zoomIn = () => setZoom(z => Math.min(200, z + 10));
  const zoomOut = () => setZoom(z => Math.max(50, z - 10));

  // Decide whether to show a placeholder or the real value
  const V = (value: string | undefined, label: string) => {
    if (tenant && value) return <span className={styles.filledValue}>{value}</span>;
    return <span className={styles.placeholder}>{`{{${label}}}`}</span>;
  };

  const rentFormatted = tenant ? tenant.rent_amount.toFixed(2).replace('.', ',') : undefined;
  const rentExtenso = tenant ? formatRentExtended(tenant.rent_amount) : undefined;
  const prazo = tenant ? `${monthsBetween(tenant.contract_start, tenant.contract_end)} meses` : undefined;

  const isTemplate = !tenant;
  const pageTitle = isTemplate ? 'Modelo de Contrato' : `Contrato — ${tenant.full_name}`;

  return (
    <div className={styles.container}>
      {/* TOOLBAR */}
      <div className={styles.toolbar}>
        <Link href={tenantId ? '/tenants' : '/documents'} className={styles.backBtn}>
          <ArrowLeft size={16} /> Voltar
        </Link>
        <span className={styles.toolbarTitle}>{pageTitle}</span>
        <span className={styles.toolbarBadge}>{isTemplate ? 'Modelo' : 'Preenchido'}</span>
        <div className={styles.toolbarSpacer} />

        <div className={styles.toolbarGroup}>
          <div className={styles.zoomGroup}>
            <button className={styles.zoomBtn} onClick={zoomOut}><ZoomOut size={14} /></button>
            <span className={styles.zoomLevel}>{zoom}%</span>
            <button className={styles.zoomBtn} onClick={zoomIn}><ZoomIn size={14} /></button>
          </div>
          <button className={styles.toolBtn} onClick={handlePrint}>
            <Printer size={15} /> Imprimir
          </button>
          <button className={styles.toolBtnPrimary} onClick={() => void handleDownloadPDF()}>
            <Download size={15} /> Baixar PDF
          </button>
        </div>
      </div>

      {/* VIEWER */}
      <div className={styles.viewer}>
        {loading ? (
          <div className={styles.loadingState}>Carregando dados do inquilino...</div>
        ) : (
          <div className={styles.documentWrapper} ref={wrapperRef} style={{ transform: `scale(${zoom / 100})` }}>
            <div className={styles.document} ref={docRef}>

              <div className={styles.docTitle}>CONTRATO DE LOCAÇÃO DE IMÓVEL RESIDENCIAL</div>

              {/* LOCADOR */}
              <div className={styles.partyBox}>
                <span className={styles.partyLabel}>LOCADOR</span>
                <p>
                  <strong>LOCADOR — ESPÓLIO DE ORLANDO OLIVEIRA COSTA</strong>, neste ato representado por seu
                  inventariante André Luiz de Oliveira Costa, brasileiro, solteiro, advogado, portador do RG n°
                  710871 SSP/MS e do CPF n° 601.110.461-49, com endereço profissional na Rua 14 de Julho n°
                  164, Bairro Santa Dorothéa em Campo Grande/MS.
                </p>
              </div>

              {/* LOCATÁRIO */}
              <div className={styles.partyBox}>
                <span className={styles.partyLabel}>LOCATÁRIO</span>
                <p>
                  <strong>LOCATÁRIO(S)</strong> — {V(tenant?.full_name, 'LOCATARIO_NOME')},
                  RG {V(tenant?.rg, 'LOCATARIO_RG')},
                  inscrito no CPF sob o n.º {V(tenant?.cpf, 'LOCATARIO_CPF')},{' '}
                  {V(tenant?.occupation, 'LOCATARIO_PROFISSAO')},
                  residente e domiciliado na {V(tenant?.reference_address, 'LOCATARIO_ENDERECO')}.
                </p>
              </div>

              {/* CLÁUSULA PRIMEIRA */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA PRIMEIRA — OBJETO DA LOCAÇÃO</span> — Imóvel para uso exclusivamente residencial
                  pelo morador {V(tenant?.full_name, 'LOCATARIO_NOME')},
                  consistindo em uma suíte mobiliada,
                  situado à Av. Eduardo Elias Zahran, nº 438,
                  Bairro Jardim Paulista em Campo Grande/MS — CEP 79051-485,
                  contendo cama de casal, geladeira, fogão, guarda-roupas e banheiro com chuveiro elétrico,
                  para 01 (uma) pessoa(s),
                  incluso água e energia elétrica, wi-fi em caráter de cortesia.
                </p>
                <p><strong>Parágrafo único.</strong></p>
              </div>

              {/* CLÁUSULA SEGUNDA */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA SEGUNDA — PRAZO DA LOCAÇÃO</span> — A presente locação tem prazo determinado
                  de {V(prazo, 'CONTRATO_PRAZO')}{' '}
                  com início em {V(tenant ? formatDateBR(tenant.contract_start) : undefined, 'CONTRATO_INICIO')}{' '}
                  a {V(tenant ? formatDateBR(tenant.contract_end) : undefined, 'CONTRATO_FIM')},
                  findo o qual o imóvel deverá ser devolvido ao LOCADOR, independentemente de aviso ou notificação.
                </p>
              </div>

              {/* CLÁUSULA TERCEIRA */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA TERCEIRA — VALOR DA LOCAÇÃO</span> — O valor do aluguel será de
                  R$ {V(rentFormatted, 'ALUGUEL_VALOR')}{' '}
                  ({V(rentExtenso, 'ALUGUEL_EXTENSO')}){' '}
                  com vencimento todo dia {V(tenant?.due_day?.toString(), 'ALUGUEL_VENCIMENTO')}.
                </p>
                <p className={styles.subClause}>
                  § 1º — O valor do aluguel será reajustado a cada 12 (doze) meses, de acordo com a variação do
                  índice IGPM/FGV, ou outro índice que vier a substituí-lo.
                </p>
                <p className={styles.subClause}>
                  § 2° — O vencimento do aluguel será todo dia {V(tenant?.due_day?.toString(), 'ALUGUEL_VENCIMENTO')} de cada mês.
                </p>
                <p className={styles.subClause}>
                  § 3° — Ocorrendo atraso o LOCATÁRIO arcará com pagamento de multa de 10%, juros moratórios
                  de 1% a.m., correção monetária pelo índice IGPM/FGV ou outro índice que vier a substituí-lo.
                </p>
                <p className={styles.subClause}>
                  § 4° — Os pagamentos dos aluguéis e demais encargos deverão ser realizados no seguinte
                  endereço: Rua 14 de Julho, nº 164, Vila Santa Dorothéa, em Campo Grande/MS, CEP 79004-394,
                  em horário comercial.
                </p>
              </div>

              {/* CONDIÇÕES GERAIS */}
              <div className={styles.clauseSubtitle}>CONDIÇÕES GERAIS</div>

              {/* CLÁUSULA QUARTA */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA QUARTA</span> — No término da Locação, o LOCATÁRIO deverá restituir o imóvel ao
                  LOCADOR, independentemente de qualquer notificação judicial ou extrajudicial, no estado em
                  que o recebeu, devidamente pintado com material de primeira linha e com todas as portas,
                  janelas, vidros, fechaduras, piso, forro, instalações elétricas e hidráulicas funcionando
                  regularmente.
                </p>
              </div>

              {/* CLÁUSULA QUINTA */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA QUINTA</span> — O presente contrato é para moradia exclusiva do LOCATÁRIO, sendo
                  vedada a ocupação de terceiros, sem a expressa autorização mediante negociação com o
                  proprietário para estipulação de novo valor adicional a este contrato, bem como declara que
                  recebe neste momento as Regras de Convivência comunitária anexa a este instrumento, sendo
                  que o valor constante da cláusula do pagamento é válido para apenas um morador.
                </p>
              </div>

              {/* CLÁUSULA SEXTA */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA SEXTA</span> — Durante a vigência da locação, não poderá o LOCATÁRIO, sem
                  consentimento por escrito do LOCADOR, ceder, emprestar ou sublocar no todo ou em parte, o
                  imóvel, objeto deste contrato.
                </p>
              </div>

              {/* CLÁUSULA SÉTIMA */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA SÉTIMA</span> — Deverá o LOCATÁRIO cientificar imediatamente o LOCADOR de
                  quaisquer documentos de cobrança de tributos ou encargos, bem como quaisquer intimações ou
                  exigências de autoridades públicas, ainda que dirigidas a ele LOCADOR, sob pena de não o
                  fazendo ou demorando-se a fazê-lo, responder civil ou criminalmente pelos prejuízos advindos.
                </p>
              </div>

              {/* CLÁUSULA OITAVA */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA OITAVA</span> — Se o LOCADOR necessitar de intervenção de advogado para receber
                  aluguéis ou encargos, seja de forma extrajudicial ou judicial, pagará o LOCATÁRIO, além das
                  cominações previstas neste instrumento, os honorários do profissional contratado, na base de
                  10% (dez por cento) no primeiro caso e 20% (vinte por cento) no segundo caso, sobre o valor
                  total devido.
                </p>
              </div>

              {/* CLÁUSULA NONA */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA NONA</span> — Expirado o prazo do presente contrato, poderá o mesmo ser renovado em
                  novas bases, de comum acordo entre as partes. Caso, porém, continue o LOCATÁRIO no imóvel,
                  sem pactuar a renovação, permanecerão em vigor todas as cláusulas e condições do presente
                  instrumento até a entrega real e definitiva do imóvel locado, com exceção do valor do aluguel
                  que será corrigido conforme lei em vigor.
                </p>
              </div>

              {/* CLÁUSULA DÉCIMA */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA DÉCIMA</span> — O presente contrato será resolvido de plano nos casos de incêndio,
                  vendaval, desapropriação, obras determinadas pela autoridade pública que importem na
                  impossibilidade de habitação ou utilização do imóvel por mais de 30 (trinta) dias, determinações
                  judiciais ou quaisquer outros fatos de força maior que impeçam o uso do imóvel locado,
                  independentemente de notificação ou interpelação e sem conferir ao LOCATÁRIO qualquer
                  direito de pleitear indenização ao LOCADOR, quando este não houver dado causa, ficando,
                  entretanto, assegurado a ele o direito de pleitear de terceiros possíveis indenizações.
                </p>
              </div>

              {/* CLÁUSULA DÉCIMA PRIMEIRA */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA DÉCIMA PRIMEIRA</span> — É expressamente vedado ao LOCATÁRIO introduzir no
                  imóvel quaisquer benfeitorias úteis, necessárias ou voluptuárias sem consentimento expresso
                  do LOCADOR. Se mesmo sem autorização assim proceder, ditas benfeitorias serão a critério do
                  LOCADOR consideradas incorporadas ao imóvel e não darão margem à direito de retenção ou
                  indenização, ou serão desfeitas às custas do LOCATÁRIO.
                </p>
                <p className={styles.subClause}>
                  <strong>Parágrafo único</strong> — Os reparos, os consertos e a manutenção do imóvel, além de serem
                  efetuados com o consentimento do LOCADOR, deverão ser executados com material de boa
                  qualidade e mão de obra qualificada, de modo a mantê-lo permanentemente em condições de uso.
                </p>
              </div>

              {/* CLÁUSULA DÉCIMA SEGUNDA */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA DÉCIMA SEGUNDA</span> — Constitui-se em obrigação do LOCATÁRIO manter o imóvel
                  locado com o mesmo cuidado como se fosse seu. Para tanto, declara havê-lo recebido em
                  perfeitas condições, conforme o termo de vistoria o qual passará a fazer parte integrante deste
                  contrato.
                </p>
              </div>

              {/* CLÁUSULA DÉCIMA TERCEIRA */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA DÉCIMA TERCEIRA</span> — O LOCATÁRIO não poderá sob qualquer pretexto impedir
                  a visita periódica do LOCADOR com o fim de vistoriar o seu bom uso e zelo.
                </p>
              </div>

              {/* CLÁUSULA DÉCIMA QUARTA */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA DÉCIMA QUARTA</span> — Assume o LOCATÁRIO o formal compromisso de comunicar
                  expressamente o interesse em desocupar o imóvel 30 (trinta) dias antes da efetiva desocupação,
                  devendo ainda solicitar ao LOCADOR que faça uma vistoria no imóvel, a fim de constatar o seu
                  estado de conservação, sob pena de arcar com mais uma mensalidade da locação.
                </p>
              </div>

              {/* CLÁUSULA DÉCIMA QUINTA */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA DÉCIMA QUINTA</span> — A efetiva devolução do imóvel implica em efetiva entrega das
                  chaves, sendo que para que tenha eficácia, deverá ser feita contrarrecibo, no endereço declinado
                  no § 4º da Cláusula Terceira.
                </p>
              </div>

              {/* CLÁUSULA DÉCIMA SEXTA */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA DÉCIMA SEXTA</span> — A tolerância do LOCADOR pelo não cumprimento de qualquer
                  ato ou obrigação que em virtude deste contrato deva ser praticada ou cumprida, não poderá ser
                  tida como alteração ou novação do contido neste instrumento, sendo convencionado o seu
                  reconhecimento como mera liberalidade.
                </p>
              </div>

              {/* CLÁUSULA DÉCIMA SÉTIMA — High Energy Appliances */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA DÉCIMA SÉTIMA</span> — É expressamente proibido o uso de aparelhos eletrônicos
                  de alta consumação energética no imóvel locado, incluindo, mas não se limitando a: fogões e fornos
                  elétricos ou de indução, ar-condicionado portátil ou fixo, aquecedores elétricos, radiadores,
                  secadoras de roupa, máquinas de lavar de grande porte, churrasqueiras elétricas, fritadeiras
                  industriais, e similares. Caso o morador deseje utilizar algum aparelho desta natureza, deverá
                  comunicar previamente ao LOCADOR para negociação de ajuste contratual e eventual adequação
                  do valor do aluguel.
                </p>
              </div>

              {/* CLÁUSULA DÉCIMA OITAVA — Furniture Repair */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA DÉCIMA OITAVA</span> — Os móveis e equipamentos fornecidos pelo LOCADOR,
                  conforme descrito na Cláusula Primeira, serão objeto de manutenção conforme as seguintes condições:
                </p>
                <p className={styles.subClause}>
                  § 1º — Danos decorrentes de <strong>desgaste natural pelo uso regular</strong> serão reparados ou substituídos
                  pelo LOCADOR, sem custo para o LOCATÁRIO, desde que devidamente comunicados à administração
                  para avaliação prévia.
                </p>
                <p className={styles.subClause}>
                  § 2º — Danos decorrentes de <strong>mau uso, negligência ou uso indevido</strong> por parte do LOCATÁRIO
                  serão integralmente custeados pelo mesmo, conforme avaliação da administração. O LOCATÁRIO
                  será notificado do valor do reparo ou substituição e deverá efetuar o pagamento no prazo de
                  15 (quinze) dias a partir da notificação.
                </p>
                <p className={styles.subClause}>
                  § 3º — A classificação do tipo de dano (desgaste natural ou mau uso) será de competência
                  exclusiva da administração, que realizará vistoria técnica e emitirá laudo justificativo quando solicitado.
                </p>
              </div>

              {/* CLÁUSULA DÉCIMA NONA — Regimento Interno */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA DÉCIMA NONA</span> — O LOCATÁRIO declara ter pleno conhecimento e se compromete
                  a cumprir integralmente o <strong>Regimento Interno</strong> do imóvel, que constitui parte integrante deste contrato
                  na qualidade de <strong>Anexo I</strong>. O descumprimento das normas do Regimento Interno será considerado
                  infração contratual, sujeitando o LOCATÁRIO às penalidades previstas neste instrumento.
                </p>
                <p className={styles.subClause}>
                  <strong>Parágrafo único</strong> — O LOCADOR reserva-se o direito de atualizar o Regimento Interno mediante
                  comunicação prévia de 15 (quinze) dias ao LOCATÁRIO, passando as novas regras a vigorar
                  automaticamente após este prazo.
                </p>
              </div>

              {/* CLÁUSULA VIGÉSIMA — Early Termination */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA VIGÉSIMA</span> — Caso o LOCATÁRIO deseje desocupar o imóvel antes do término
                  do contrato, deverá comunicar formalmente à administração com antecedência mínima de
                  15 (quinze) dias.
                </p>
                <p className={styles.subClause}>
                  § 1º — Sendo a comunicação realizada dentro do prazo estipulado, nenhuma cobrança adicional
                  será aplicada ao LOCATÁRIO, ficando este responsável apenas pelos aluguéis e encargos devidos
                  até a data efetiva da desocupação.
                </p>
                <p className={styles.subClause}>
                  § 2º — Caso o LOCATÁRIO desocupe o imóvel sem a devida comunicação prévia de 15 (quinze) dias,
                  ou abandone o imóvel sem aviso, o ato será considerado <strong>quebra de contrato</strong>, ficando o
                  LOCATÁRIO obrigado ao pagamento de multa equivalente a <strong>30% (trinta por cento) do valor
                  total dos aluguéis remanescentes</strong> até o término originalmente previsto do contrato.
                </p>
                <p className={styles.subClause}>
                  § 3º — O valor da multa por quebra de contrato será calculado com base no aluguel vigente
                  à data da desocupação, multiplicado pelo número de meses restantes e aplicado o percentual
                  de 30% sobre o montante total.
                </p>
              </div>

              {/* CLÁUSULA VIGÉSIMA PRIMEIRA — Penalty */}
              <div className={styles.clause}>
                <p>
                  <span className={styles.clauseTitle}>CLÁUSULA VIGÉSIMA PRIMEIRA</span> — Fica estipulada multa correspondente a 03 (três) aluguéis à
                  parte que infringir qualquer uma das cláusulas.
                </p>
                <p className={styles.subClause}>
                  <strong>Parágrafo único</strong> — A multa será sempre paga integralmente, seja qual for o tempo decorrido do
                  presente contrato e não será compensatória de prejuízos e/ou danos causados ao imóvel, nem
                  poderá ser tida como indenizatória de aluguéis ou encargos devidos.
                </p>
              </div>

              {/* SIGNATURES */}
              <div className={styles.signatures}>
                <p style={{ textAlign: 'justify', marginBottom: 8 }}>
                  E por estarem assim, justos e contratados, cientes e de acordo com tudo o quanto neste
                  instrumento foi lavrado, firmam em formato digital através do WhatsApp.
                </p>

                <div className={styles.dateLine}>
                  Campo Grande/MS, {V(tenant ? todayBR() : undefined, 'CONTRATO_DATA')}.
                </div>

                <div className={styles.sigRow}>
                  <div className={styles.sigBlock}>
                    <div className={styles.sigLine}>
                      <div className={styles.sigName}>ESPÓLIO DE ORLANDO OLIVEIRA COSTA</div>
                      <div className={styles.sigRole}>LOCADOR</div>
                    </div>
                  </div>
                  <div className={styles.sigBlock}>
                    <div className={styles.sigLine}>
                      <div className={styles.sigName}>{V(tenant?.full_name, 'LOCATARIO_NOME')}</div>
                      <div className={styles.sigRole}>LOCATÁRIO</div>
                    </div>
                  </div>
                </div>
              </div>

            </div>
          </div>
        )}
      </div>

      {/* TOAST */}
      {toast && (
        <div className={styles.toast}>
          <FileText size={16} /> {toast}
        </div>
      )}
    </div>
  );
}
