// Coleta os dados da Pluggy (via Meu Pluggy), monta o resumo e grava
// _site/data.enc.json criptografado com a senha do app (AES-256-GCM).
//
// Variáveis de ambiente:
//   APP_SENHA             senha usada para criptografar (obrigatória com dados reais)
//   PLUGGY_CLIENT_ID      credenciais da aplicação no dashboard da Pluggy
//   PLUGGY_CLIENT_SECRET
//   PLUGGY_ITEM_IDS       Item IDs copiados do Meu Pluggy, separados por vírgula
//   PAGES_URL             URL do app publicado (para recuperar o histórico)
//   MESES                 quantos meses de transações buscar (padrão 6)
//   SAIDA                 arquivo de saída (padrão _site/data.enc.json)

import { webcrypto as crypto } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const API = 'https://api.pluggy.ai';
const env = process.env;
const SAIDA = env.SAIDA || '_site/data.enc.json';
const MESES = Number(env.MESES || 6);
const ITERACOES = 250000;

// ---------- criptografia (compatível com WebCrypto do navegador) ----------
const b64 = (buf) => Buffer.from(buf).toString('base64');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function derivarChave(senha, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERACOES, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function criptografar(obj, senha) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const chave = await derivarChave(senha, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, chave, new TextEncoder().encode(JSON.stringify(obj)));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: ITERACOES, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export async function descriptografar(pacote, senha) {
  const chave = await derivarChave(senha, fromB64(pacote.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(pacote.iv) }, chave, fromB64(pacote.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ---------- Pluggy ----------
let apiKey = null;

async function pluggy(caminho, opts = {}) {
  const r = await fetch(API + caminho, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'X-API-KEY': apiKey } : {}), ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Pluggy ${caminho} -> HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function paginado(caminho) {
  const sep = caminho.includes('?') ? '&' : '?';
  let pagina = 1, todos = [];
  while (true) {
    const r = await pluggy(`${caminho}${sep}pageSize=500&page=${pagina}`);
    todos = todos.concat(r.results || []);
    if (!r.totalPages || pagina >= r.totalPages) break;
    pagina++;
  }
  return todos;
}

async function coletarPluggy() {
  ({ apiKey } = await pluggy('/auth', {
    method: 'POST',
    body: JSON.stringify({ clientId: env.PLUGGY_CLIENT_ID, clientSecret: env.PLUGGY_CLIENT_SECRET }),
  }));

  const ids = env.PLUGGY_ITEM_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  const desde = new Date();
  desde.setMonth(desde.getMonth() - MESES, 1);
  const from = desde.toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);

  const contas = [], transacoes = [], investimentos = [], avisos = [];

  for (const itemId of ids) {
    let instituicao = 'Banco';
    try {
      const item = await pluggy(`/items/${itemId}`);
      instituicao = item.connector?.name || instituicao;
      if (item.status && !['UPDATED', 'UPDATING'].includes(item.status)) {
        avisos.push(`${instituicao}: status ${item.status}${item.executionStatus ? ' (' + item.executionStatus + ')' : ''}`);
      }
    } catch (e) {
      avisos.push(`Item ${itemId.slice(0, 8)}…: ${e.message}`);
      continue;
    }

    const accs = await paginado(`/accounts?itemId=${itemId}`);
    for (const a of accs) {
      const credito = a.type === 'CREDIT';
      contas.push({
        id: a.id,
        instituicao,
        nome: a.marketingName || a.name || (credito ? 'Cartão' : 'Conta'),
        tipo: credito ? 'cartao' : 'conta',
        saldo: a.balance ?? 0,
        limite: a.creditData?.creditLimit ?? null,
        limiteDisponivel: a.creditData?.availableCreditLimit ?? null,
        vencimento: a.creditData?.balanceDueDate ?? null,
      });
      const txs = await paginado(`/transactions?accountId=${a.id}&from=${from}&to=${to}`);
      for (const t of txs) {
        transacoes.push({
          id: t.id,
          conta: a.id,
          data: (t.date || '').slice(0, 10),
          descricao: t.merchant?.name || t.description || '',
          descricaoOriginal: t.descriptionRaw || t.description || '',
          valor: Math.abs(Number(t.amount) || 0),
          tipo: t.type === 'CREDIT' ? 'entrada' : 'saida',
          categoriaOriginal: t.category || '',
          parcela: t.creditCardMetadata?.installmentNumber
            ? `${t.creditCardMetadata.installmentNumber}/${t.creditCardMetadata.totalInstallments || '?'}` : null,
          pendente: t.status === 'PENDING',
        });
      }
    }

    try {
      const invs = await paginado(`/investments?itemId=${itemId}`);
      for (const i of invs) {
        investimentos.push({
          id: i.id,
          instituicao,
          nome: i.name || i.code || 'Investimento',
          tipo: i.type || 'OUTRO',
          subtipo: i.subtype || null,
          saldo: i.balance ?? i.amount ?? 0,
          aplicado: i.amountOriginal ?? null,
          rendimento: i.amountProfit ?? null,
          taxa: i.rate != null ? `${i.rate}${i.rateType ? ' ' + i.rateType : ''}` : null,
          vencimento: i.dueDate ? i.dueDate.slice(0, 10) : null,
        });
      }
    } catch (e) {
      avisos.push(`${instituicao}: investimentos indisponíveis (${e.message.slice(0, 80)})`);
    }
  }
  return { contas, transacoes, investimentos, avisos };
}

// ---------- categorias ----------
// A Pluggy devolve categorias em inglês. Agrupamos em categorias simples em português.
const GRUPOS = [
  ['ignorar', /credit card payment|same person transfer|investments?$|^investment|proceeds|interests? (charged|earned)?$|fixed income|variable income|mutual funds|pension/i],
  ['Mercado', /groceries|supermarket/i],
  ['Saúde', /health|pharmacy|drugstore|hospital|clinic|dentist|gym|fitness|wellness/i],
  ['Assinaturas digitais', /digital services|streaming|software|gaming|apps?$/i],
  ['Restaurantes e delivery', /food|eating out|restaurant|delivery|bars?$|coffee|bakery/i],
  ['Transporte', /transport|taxi|ride|gas station|fuel|parking|toll|public transportation|car|vehicle|automotive|airport/i],
  ['Moradia', /housing|rent|electricity|water|gas$|condominium|maintenance|home/i],
  ['Contas e serviços', /telecom|internet|mobile|phone|utilities|services|cable/i],
  ['Compras', /shopping|online shopping|clothing|electronics|houseware|department|pet|bookstore|gifts?/i],
  ['Lazer e viagem', /leisure|entertainment|travel|tickets|hotel|lodging|accommodation|cinema|events|sports/i],
  ['Educação', /education|school|university|courses?|books/i],
  ['Taxas e impostos', /tax|bank fees|fees|fines|iof|tariff/i],
  ['Empréstimos', /loan|financing|late payment/i],
  ['Doações', /donation|charity/i],
  ['Transferências', /transfer|pix|ted|doc/i],
  ['Renda', /income|salary|wages|retirement|benefits|refund|cashback/i],
];
const IGNORAR_DESC = /pagamento (de )?fatura|pagamento recebido|pgto fatura|aplica[cç][aã]o|resgate|rendimento|nu invest|caixinha|cofrinho/i;

function categorizar(t) {
  if (IGNORAR_DESC.test(t.descricaoOriginal) || IGNORAR_DESC.test(t.descricao)) return 'ignorar';
  for (const [nome, re] of GRUPOS) if (re.test(t.categoriaOriginal)) return nome;
  return t.categoriaOriginal ? 'Outros' : 'Sem categoria';
}

// ---------- demo ----------
function dadosDemo() {
  const hoje = new Date();
  let semente = 42;
  const rand = () => ((semente = (semente * 16807) % 2147483647) / 2147483647);
  const modelos = [
    ['Supermercado Dia', 'Groceries', 60, 260], ['iFood', 'Food delivery', 25, 85], ['Uber', 'Taxi and ride-hailing', 12, 45],
    ['Padaria Pão Quente', 'Bakery', 8, 30], ['Posto Shell', 'Gas stations', 80, 200], ['Netflix', 'Video streaming', 44.9, 44.9],
    ['Spotify', 'Music streaming', 21.9, 21.9], ['Mercado Livre', 'Online shopping', 40, 300], ['Drogasil', 'Pharmacy', 20, 120],
    ['Smart Fit', 'Gyms and fitness centers', 119.9, 119.9], ['Enel', 'Electricity', 140, 220], ['Vivo Fibra', 'Internet', 99.9, 99.9],
    ['Cinemark', 'Cinema, theater and concerts', 30, 80], ['Restaurante Sabor', 'Eating out', 35, 120],
  ];
  const transacoes = [];
  for (let m = MESES - 1; m >= 0; m--) {
    const base = new Date(hoje.getFullYear(), hoje.getMonth() - m, 1);
    const dias = m === 0 ? hoje.getDate() : new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    const dia = (d) => new Date(base.getFullYear(), base.getMonth(), Math.min(d, dias)).toISOString().slice(0, 10);
    transacoes.push({ id: `sal${m}`, conta: 'c1', data: dia(5), descricao: 'Salário', descricaoOriginal: 'TED SALARIO', valor: 4800, tipo: 'entrada', categoriaOriginal: 'Salary' });
    transacoes.push({ id: `alu${m}`, conta: 'c1', data: dia(10), descricao: 'Aluguel', descricaoOriginal: 'PIX ALUGUEL', valor: 1350, tipo: 'saida', categoriaOriginal: 'Rent' });
    transacoes.push({ id: `fat${m}`, conta: 'c1', data: dia(12), descricao: 'Pagamento de fatura', descricaoOriginal: 'Pagamento de fatura', valor: 1500, tipo: 'saida', categoriaOriginal: 'Credit card payment' });
    for (let i = 0; i < Math.round(dias * 1.3); i++) {
      const [d, c, min, max] = modelos[Math.floor(rand() * modelos.length)];
      transacoes.push({ id: `t${m}_${i}`, conta: rand() > 0.35 ? 'k1' : 'k2', data: dia(1 + Math.floor(rand() * dias)), descricao: d, descricaoOriginal: d.toUpperCase(),
        valor: Math.round((min + rand() * (max - min)) * 100) / 100, tipo: 'saida', categoriaOriginal: c });
    }
  }
  return {
    contas: [
      { id: 'c1', instituicao: 'Nubank', nome: 'Conta Nubank', tipo: 'conta', saldo: 2310.45 },
      { id: 'k1', instituicao: 'Nubank', nome: 'Cartão Nubank', tipo: 'cartao', saldo: 1842.3, limite: 6000, limiteDisponivel: 4157.7 },
      { id: 'c2', instituicao: 'PicPay', nome: 'Conta PicPay', tipo: 'conta', saldo: 380.12 },
      { id: 'k2', instituicao: 'PicPay', nome: 'Cartão PicPay', tipo: 'cartao', saldo: 512.9, limite: 2500, limiteDisponivel: 1987.1 },
    ],
    transacoes,
    investimentos: [
      { id: 'i1', instituicao: 'Nubank', nome: 'Caixinha Reserva', tipo: 'FIXED_INCOME', subtipo: 'CDB', saldo: 8420.33, aplicado: 8000, rendimento: 420.33, taxa: '100 CDI' },
      { id: 'i2', instituicao: 'Nubank', nome: 'Tesouro Selic 2029', tipo: 'FIXED_INCOME', subtipo: 'TREASURY', saldo: 3150.8, aplicado: 3000, rendimento: 150.8 },
      { id: 'i3', instituicao: 'Nubank', nome: 'NU Reserva Planejada', tipo: 'MUTUAL_FUND', subtipo: 'INVESTMENT_FUND', saldo: 1980.12, aplicado: 1900, rendimento: 80.12 },
      { id: 'i4', instituicao: 'Nubank', nome: 'BOVA11', tipo: 'ETF', subtipo: 'ETF', saldo: 1210.5, aplicado: 1300, rendimento: -89.5 },
    ],
    avisos: ['Dados de demonstração — configure os segredos da Pluggy para ver seus dados reais.'],
  };
}

// ---------- histórico ----------
async function historicoAnterior(senha) {
  if (!env.PAGES_URL) return [];
  try {
    const r = await fetch(env.PAGES_URL.replace(/\/$/, '') + '/data.enc.json', { cache: 'no-store' });
    if (!r.ok) return [];
    const antigo = await descriptografar(await r.json(), senha);
    return Array.isArray(antigo.historico) ? antigo.historico : [];
  } catch {
    return []; // primeira execução, senha trocada ou demo -> começa do zero
  }
}

// ---------- main ----------
async function main() {
  const real = env.PLUGGY_CLIENT_ID && env.PLUGGY_CLIENT_SECRET && env.PLUGGY_ITEM_IDS;
  const senha = real ? env.APP_SENHA : (env.APP_SENHA || 'demo');
  if (!senha) throw new Error('Defina o segredo APP_SENHA no repositório.');

  console.log(real ? 'Coletando dados reais da Pluggy…' : 'Segredos da Pluggy ausentes: gerando dados de demonstração.');
  const bruto = real ? await coletarPluggy() : dadosDemo();

  const transacoes = bruto.transacoes
    .map((t) => ({ ...t, categoria: categorizar(t) }))
    .sort((a, b) => b.data.localeCompare(a.data));

  const hoje = new Date().toISOString().slice(0, 10);
  const totalInvestido = bruto.investimentos.reduce((s, i) => s + (i.saldo || 0), 0);
  const saldoContas = bruto.contas.filter((c) => c.tipo === 'conta').reduce((s, c) => s + (c.saldo || 0), 0);

  let historico = (await historicoAnterior(senha)).filter((h) => h.data !== hoje);
  historico.push({ data: hoje, investido: round(totalInvestido), contas: round(saldoContas) });
  historico = historico.sort((a, b) => a.data.localeCompare(b.data)).slice(-730);

  if (!real) { // histórico fictício para a demo
    historico = [];
    for (let m = 11; m >= 0; m--) {
      const d = new Date(); d.setMonth(d.getMonth() - m, 1);
      historico.push({ data: d.toISOString().slice(0, 10), investido: round(totalInvestido * (0.62 + 0.38 * (11 - m) / 11)), contas: round(saldoContas) });
    }
  }

  const dados = {
    geradoEm: new Date().toISOString(),
    demo: !real,
    contas: bruto.contas,
    transacoes,
    investimentos: bruto.investimentos,
    historico,
    avisos: bruto.avisos,
  };

  const pacote = await criptografar(dados, senha);
  await mkdir(dirname(SAIDA), { recursive: true });
  await writeFile(SAIDA, JSON.stringify(pacote));
  console.log(`OK: ${bruto.contas.length} contas, ${transacoes.length} transações, ${bruto.investimentos.length} investimentos -> ${SAIDA}`);
  for (const a of bruto.avisos) console.log('Aviso:', a);
}

function round(n) { return Math.round(n * 100) / 100; }

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
