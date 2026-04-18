import type { PaymentItem, Tenant } from './types';

export const numberToPortuguese = (n: number): string => {
  if (n === 0) return 'zero';
  const units = [
    '', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove',
    'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove',
  ];
  const tens = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
  const hundreds = [
    '', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos',
    'seiscentos', 'setecentos', 'oitocentos', 'novecentos',
  ];

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

export const formatMoneyExtended = (value: number): string => {
  const intPart = Math.floor(value);
  const cents = Math.round((value - intPart) * 100);
  let result = numberToPortuguese(intPart) + ' reais';
  if (cents > 0) result += ` e ${numberToPortuguese(cents)} centavos`;
  return result;
};

export const formatDateBR = (isoDate: string): string => {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString('pt-BR');
};

export const formatMoneyBR = (value: number): string =>
  (value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const monthsBetween = (start: string, end: string): number => {
  const s = new Date(start);
  const e = new Date(end);
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24 * 30)));
};

export const todayBR = (): string => {
  const d = new Date();
  const months = [
    'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
  ];
  return `${d.getDate()} de ${months[d.getMonth()]} de ${d.getFullYear()}`;
};

export const monthLabel = (month: string): string => {
  if (!month) return '';
  const months = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
  ];
  const [y, m] = month.split('-');
  const idx = parseInt(m, 10) - 1;
  return `${months[idx] || m} / ${y}`;
};

export const paymentMethodLabel = (method: string): string => {
  const map: Record<string, string> = {
    manual: 'Pagamento Manual',
    pix: 'PIX',
    bank_transfer: 'Transferência Bancária',
    cash: 'Dinheiro',
    credit_card: 'Cartão de Crédito',
    debit_card: 'Cartão de Débito',
    boleto: 'Boleto',
  };
  return map[method] || method || 'Pagamento Manual';
};

const escapeHtml = (raw: string): string =>
  String(raw || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

const safeVal = (raw: string, placeholder: string): string => {
  if (!raw) return `<span class="placeholder">{{${placeholder}}}</span>`;
  return escapeHtml(raw);
};

export const buildContractPlaceholders = (tenant: Tenant | null): Record<string, string> => {
  if (!tenant) {
    return {
      LOCATARIO_NOME: '<span class="placeholder">{{LOCATARIO_NOME}}</span>',
      LOCATARIO_RG: '<span class="placeholder">{{LOCATARIO_RG}}</span>',
      LOCATARIO_CPF: '<span class="placeholder">{{LOCATARIO_CPF}}</span>',
      LOCATARIO_PROFISSAO: '<span class="placeholder">{{LOCATARIO_PROFISSAO}}</span>',
      LOCATARIO_ENDERECO: '<span class="placeholder">{{LOCATARIO_ENDERECO}}</span>',
      CONTRATO_PRAZO: '<span class="placeholder">{{CONTRATO_PRAZO}}</span>',
      CONTRATO_INICIO: '<span class="placeholder">{{CONTRATO_INICIO}}</span>',
      CONTRATO_FIM: '<span class="placeholder">{{CONTRATO_FIM}}</span>',
      ALUGUEL_VALOR: '<span class="placeholder">{{ALUGUEL_VALOR}}</span>',
      ALUGUEL_EXTENSO: '<span class="placeholder">{{ALUGUEL_EXTENSO}}</span>',
      ALUGUEL_VENCIMENTO: '<span class="placeholder">{{ALUGUEL_VENCIMENTO}}</span>',
      CONTRATO_DATA: '<span class="placeholder">{{CONTRATO_DATA}}</span>',
    };
  }
  const rent = tenant.rent_amount || 0;
  const prazo = tenant.contract_start && tenant.contract_end
    ? `${monthsBetween(tenant.contract_start, tenant.contract_end)} meses`
    : '';
  return {
    LOCATARIO_NOME: safeVal(tenant.full_name, 'LOCATARIO_NOME'),
    LOCATARIO_RG: safeVal(tenant.rg, 'LOCATARIO_RG'),
    LOCATARIO_CPF: safeVal(tenant.cpf, 'LOCATARIO_CPF'),
    LOCATARIO_PROFISSAO: safeVal(tenant.occupation, 'LOCATARIO_PROFISSAO'),
    LOCATARIO_ENDERECO: safeVal(tenant.reference_address, 'LOCATARIO_ENDERECO'),
    CONTRATO_PRAZO: safeVal(prazo, 'CONTRATO_PRAZO'),
    CONTRATO_INICIO: safeVal(tenant.contract_start ? formatDateBR(tenant.contract_start) : '', 'CONTRATO_INICIO'),
    CONTRATO_FIM: safeVal(tenant.contract_end ? formatDateBR(tenant.contract_end) : '', 'CONTRATO_FIM'),
    ALUGUEL_VALOR: safeVal(rent ? rent.toFixed(2).replace('.', ',') : '', 'ALUGUEL_VALOR'),
    ALUGUEL_EXTENSO: safeVal(rent ? formatMoneyExtended(rent) : '', 'ALUGUEL_EXTENSO'),
    ALUGUEL_VENCIMENTO: safeVal(tenant.due_day ? String(tenant.due_day) : '', 'ALUGUEL_VENCIMENTO'),
    CONTRATO_DATA: safeVal(todayBR(), 'CONTRATO_DATA'),
  };
};

export const buildReceiptPlaceholders = (
  tenant: Tenant | null,
  payment: PaymentItem | null,
  month: string,
): Record<string, string> => {
  const amount = payment?.amount ?? tenant?.rent_amount ?? 0;
  const lateFee = payment?.late_fee ?? 0;
  const total = amount + lateFee;
  const isPaid = payment?.status === 'paid';
  const rentFormatted = formatMoneyBR(amount);
  const totalFormatted = formatMoneyBR(total);
  const extenso = formatMoneyExtended(total);

  const linhaMulta = lateFee > 0
    ? `<tr><td><strong>Multa / Juros por atraso</strong><br><span class="item-sub">10% + 1% a.m. conforme contrato</span></td><td class="right">—</td><td class="right">${formatMoneyBR(lateFee)}</td></tr>`
    : '';
  const linhaTotalMulta = lateFee > 0
    ? `<div class="totals-row"><span>Multa / Juros</span><span>${formatMoneyBR(lateFee)}</span></div>`
    : '';

  return {
    RECIBO_NUMERO: String(payment?.id || 0).padStart(4, '0'),
    REFERENCIA_MES: safeVal(monthLabel(month), 'REFERENCIA_MES'),
    LOCATARIO_NOME: safeVal(tenant?.full_name || '', 'LOCATARIO_NOME'),
    LOCATARIO_CPF: safeVal(tenant?.cpf || '', 'LOCATARIO_CPF'),
    UNIDADE: safeVal(tenant?.unit_number || '', 'UNIDADE'),
    LOCATARIO_TELEFONE: safeVal(tenant?.phone || '', 'LOCATARIO_TELEFONE'),
    VENCIMENTO: safeVal(payment?.due_date ? formatDateBR(payment.due_date) : '', 'VENCIMENTO'),
    VALOR_ALUGUEL: rentFormatted,
    VALOR_TOTAL: totalFormatted,
    VALOR_EXTENSO: extenso,
    LINHA_MULTA: linhaMulta,
    LINHA_TOTAL_MULTA: linhaTotalMulta,
    FORMA_PAGAMENTO: payment ? paymentMethodLabel(payment.payment_method) : '—',
    DATA_PAGAMENTO: payment?.paid_at ? formatDateBR(payment.paid_at) : '—',
    STATUS_KEY: isPaid ? 'paid' : 'pending',
    STATUS_LABEL: isPaid ? 'QUITADO' : 'PENDENTE',
    DATA_EMISSAO: todayBR(),
  };
};

export const applyPlaceholders = (template: string, values: Record<string, string>): string => {
  return template.replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, (_m, key: string) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
    return `{{${key}}}`;
  });
};
