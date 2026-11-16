'use strict';

// ---------------- utilidades ----------------
const $ = (s, el = document) => el.querySelector(s);
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const brlCurto = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 });
const fmt = (n) => `<span class="sens num">${brl.format(n || 0)}</span>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mesChave = (d) => d.slice(0, 7);
const nomeMes = (chave, curto = false) => {
  const [a, m] = chave.split('-').map(Number);
  return new Date(a, m - 1, 1).toLocaleDateString('pt-BR', curto ? { month: 'short' } : { month: 'long', year: 'numeric' }).replace('.', '');
};
const dataCurta = (d) => { const [a, m, dia] = d.split('-'); return `${dia}/${m}`; };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const TIPOS_INV = {
  FIXED_INCOME: 'Renda fixa', MUTUAL_FUND: 'Fundos', EQUITY: 'Ações', ETF: 'ETFs',
  SECURITY: 'Previdência', COE: 'COE', OTHER: 'Outros', OUTRO: 'Outros',
};

// ---------------- estado ----------------
let D = null;            // dados descriptografados
let mesSel = null;       // mês selecionado na aba Gastos
let catAberta = null;
let carregadoEm = 0;

// ---------------- criptografia ----------------
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function descriptografar(p, senha) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveKey']);
  const chave = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromB64(p.salt), iterations: p.iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(p.iv) }, chave, fromB64(p.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

async function abrir(senha, lembrar) {
  const btn = $('#btn-abrir'); const erro = $('#erro-senha');
  btn.disabled = true; btn.textContent = 'Abrindo…'; erro.textContent = '';
  try {
    const r = await fetch('data.enc.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('sem-dados');
    const pacote = await r.json();
    try { D = await descriptografar(pacote, senha); }
    catch { throw new Error('senha'); }
    carregadoEm = Date.now();
    if (lembrar) store.set('fin_senha', senha); else store.del('fin_senha');
    iniciarApp();
  } catch (e) {
    store.del('fin_senha');
    erro.textContent = e.message === 'senha' ? 'Senha incorreta.'
      : e.message === 'sem-dados' ? 'Os dados ainda não foram publicados. Rode o workflow no GitHub.'
      : 'Não consegui carregar os dados. Verifique a internet.';
    $('#bloqueio').hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = 'Abrir';
  }
}

// ---------------- dados derivados ----------------
const ehGasto = (t) => t.tipo === 'saida' && t.categoria !== 'ignorar' && t.categoria !== 'Renda';
const ehReceita = (t) => t.tipo === 'entrada' && t.categoria !== 'ignorar' && !contaEhCartao(t.conta);
function contaEhCartao(id) { return D.contas.some((c) => c.id === id && c.tipo === 'cartao'); }
const nomeConta = (id) => { const c = D.contas.find((x) => x.id === id); return c ? c.nome : ''; };

function mesesDisponiveis() {
  const s = new Set(D.transacoes.map((t) => mesChave(t.data)));
  const atual = new Date().toISOString().slice(0, 7);
  s.add(atual);
  return [...s].sort();
}
function gastosDoMes(chave) { return D.transacoes.filter((t) => ehGasto(t) && mesChave(t.data) === chave); }
function somar(lista) { return lista.reduce((s, t) => s + t.valor, 0); }
function porCategoria(lista) {
  const m = new Map();
  for (const t of lista) m.set(t.categoria, (m.get(t.categoria) || 0) + t.valor);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function investimentosManuais() {
  try { return JSON.parse(store.get('fin_manuais') || '[]'); } catch { return []; }
}
function todosInvestimentos() {
  return [...D.investimentos, ...investimentosManuais().map((i) => ({ ...i, manual: true, instituicao: 'Manual' }))];
}

// ---------------- gráficos (SVG) ----------------
const tip = $('#tooltip');
function mostrarTip(ev, html) {
  tip.innerHTML = html; tip.hidden = false;
  const x = ev.clientX ?? ev.touches?.[0]?.clientX ?? 0;
  const y = ev.clientY ?? ev.touches?.[0]?.clientY ?? 0;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(Math.max(8, x - w / 2), innerWidth - w - 8) + 'px';
  tip.style.top = Math.max(8, y - h - 14) + 'px';
}
const esconderTip = () => { tip.hidden = true; };
document.addEventListener('scroll', esconderTip, { passive: true });

function escalaNice(max) {
  if (max <= 0) return [0, 1];
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const passo = [1, 2, 2.5, 5, 10].map((f) => f * exp).find((p) => max / p <= 4);
  return [Math.ceil(max / passo) * passo, passo];
}

// Gráfico de barras verticais (um único série). itens: [{rotulo, valor, tip, destaque}]
function graficoBarras(itens) {
  const W = 340, H = 170, mL = 44, mR = 4, mT = 8, mB = 22;
  const [topo, passo] = escalaNice(Math.max(...itens.map((i) => i.valor), 0));
  const iw = W - mL - mR, ih = H - mT - mB;
  const bw = Math.min(36, iw / itens.length * 0.6);
  const slot = iw / itens.length;
  let g = '';
  for (let v = 0; v <= topo + 1e-9; v += passo) {
    const y = mT + ih - (v / topo) * ih;
    g += `<line class="grid" x1="${mL}" x2="${W - mR}" y1="${y}" y2="${y}"/>`;
    g += `<text x="${mL - 6}" y="${y + 4}" text-anchor="end" class="sens">${brlCurto.format(v).replace('R$', '').trim()}</text>`;
  }
  itens.forEach((it, i) => {
    const cx = mL + slot * i + slot / 2;
    const h = topo ? (it.valor / topo) * ih : 0;
    const y = mT + ih - h;
    const r = Math.min(4, h);
    // barra com topo arredondado, ancorada na base
    g += `<path class="barra${it.destaque ? ' atual' : ''}" d="M${cx - bw / 2},${mT + ih} V${y + r} q0,-${r} ${r},-${r} H${cx + bw / 2 - r} q${r},0 ${r},${r} V${mT + ih} Z"/>`;
    g += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${esc(it.rotulo)}</text>`;
    g += `<rect class="alvo" x="${mL + slot * i}" y="${mT}" width="${slot}" height="${ih}" data-i="${i}"/>`;
  });
  const el = document.createElement('div');
  el.innerHTML = `<svg class="grafico" viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
  el.querySelectorAll('.alvo').forEach((r) => {
    const it = itens[+r.dataset.i];
    const h = (ev) => mostrarTip(ev, it.tip);
    r.addEventListener('pointerenter', h); r.addEventListener('pointermove', h);
    r.addEventListener('pointerleave', esconderTip);
    r.addEventListener('click', h);
  });
  return el;
}

// Gráfico de linha com cruz de leitura. pontos: [{data, valor}]
function graficoLinha(pontos) {
  const W = 340, H = 170, mL = 44, mR = 8, mT = 10, mB = 22;
  const vals = pontos.map((p) => p.valor);
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  const pad = (maxV - minV) * 0.15 || maxV * 0.1 || 1;
  const lo = Math.max(0, minV - pad), hi = maxV + pad;
  const iw = W - mL - mR, ih = H - mT - mB;
  const t0 = new Date(pontos[0].data).getTime(), t1 = new Date(pontos.at(-1).data).getTime();
  const X = (d) => mL + (t1 === t0 ? iw / 2 : ((new Date(d).getTime() - t0) / (t1 - t0)) * iw);
  const Y = (v) => mT + ih - ((v - lo) / (hi - lo)) * ih;
  let g = '';
  for (let k = 0; k <= 3; k++) {
    const v = lo + (hi - lo) * k / 3, y = Y(v);
    g += `<line class="grid" x1="${mL}" x2="${W - mR}" y1="${y}" y2="${y}"/>`;
    g += `<text x="${mL - 6}" y="${y + 4}" text-anchor="end" class="sens">${brlCurto.format(v).replace('R$', '').trim()}</text>`;
  }
  // rótulos do eixo x: primeiro, meio, último
  [0, Math.floor((pontos.length - 1) / 2), pontos.length - 1].filter((v, i, a) => a.indexOf(v) === i).forEach((i, k, arr) => {
    const p = pontos[i];
    g += `<text x="${X(p.data)}" y="${H - 6}" text-anchor="${k === 0 ? 'start' : k === arr.length - 1 ? 'end' : 'middle'}">${dataCurta(p.data)}/${p.data.slice(2, 4)}</text>`;
  });
  const d = pontos.map((p, i) => `${i ? 'L' : 'M'}${X(p.data).toFixed(1)},${Y(p.valor).toFixed(1)}`).join(' ');
  g += `<path class="area" d="${d} L${X(pontos.at(-1).data)},${mT + ih} L${X(pontos[0].data)},${mT + ih} Z"/>`;
  g += `<path class="linha" d="${d}"/>`;
  g += `<line class="cruz" y1="${mT}" y2="${mT + ih}" visibility="hidden"/><circle class="ponto" r="5" visibility="hidden"/>`;
  g += `<rect class="alvo" x="${mL}" y="0" width="${iw}" height="${H}"/>`;
  const el = document.createElement('div');
  el.innerHTML = `<svg class="grafico" viewBox="0 0 ${W} ${H}" role="img" style="touch-action: pan-y">${g}</svg>`;
  const svg = el.firstChild, cruz = $('.cruz', svg), ponto = $('.ponto', svg), alvo = $('.alvo', svg);
  const mover = (ev) => {
    const r = svg.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * W;
    let melhor = pontos[0];
    for (const p of pontos) if (Math.abs(X(p.data) - x) < Math.abs(X(melhor.data) - x)) melhor = p;
    const px = X(melhor.data), py = Y(melhor.valor);
    cruz.setAttribute('x1', px); cruz.setAttribute('x2', px); cruz.setAttribute('visibility', 'visible');
    ponto.setAttribute('cx', px); ponto.setAttribute('cy', py); ponto.setAttribute('visibility', 'visible');
    const [a, m, dd] = melhor.data.split('-');
    mostrarTip(ev, `<div class="t-rot">${dd}/${m}/${a}</div><div class="t-val sens">${brl.format(melhor.valor)}</div>`);
  };
  alvo.addEventListener('pointermove', mover); alvo.addEventListener('pointerdown', mover);
  alvo.addEventListener('pointerleave', () => { cruz.setAttribute('visibility', 'hidden'); ponto.setAttribute('visibility', 'hidden'); esconderTip(); });
  return el;
}

function barrasCategorias(cats, total, mes) {
  const max = cats[0]?.[1] || 1;
  const wrap = document.createElement('div');
  cats.forEach(([nome, valor]) => {
    const pct = total ? Math.round((valor / total) * 100) : 0;
    const b = document.createElement('button');
    b.className = 'cat';
    b.setAttribute('aria-expanded', String(catAberta === nome && !!mes));
    b.innerHTML = `<div class="cat-topo"><span>${esc(nome)}<span class="pct">${pct}%</span></span><span class="num">${fmt(valor)}</span></div>
      <div class="trilho"><div style="width:${Math.max(2, (valor / max) * 100)}%"></div></div>`;
    wrap.appendChild(b);
    if (mes) {
      b.addEventListener('click', () => { catAberta = catAberta === nome ? null : nome; renderGastos(); });
      if (catAberta === nome) {
        const det = document.createElement('div');
        det.className = 'cat-detalhe';
        det.appendChild(listaTransacoes(gastosDoMes(mes).filter((t) => t.categoria === nome)));
        wrap.appendChild(det);
      }
    }
  });
  return wrap;
}

function listaTransacoes(lista, limite = 1e9) {
  const ul = document.createElement('ul'); ul.className = 'lista';
  if (!lista.length) { ul.innerHTML = '<li class="vazio">Nada por aqui.</li>'; return ul; }
  ul.innerHTML = lista.slice(0, limite).map((t) => `
    <li><div class="esq"><div class="nome">${esc(t.descricao)}${t.parcela ? `<span class="chip">${esc(t.parcela)}</span>` : ''}</div>
      <div class="det">${dataCurta(t.data)} · ${esc(t.categoria === 'ignorar' ? 'Movimentação interna' : t.categoria)} · ${esc(nomeConta(t.conta))}</div></div>
      <div class="dir ${t.tipo === 'entrada' ? 'pos' : ''}">${t.tipo === 'entrada' ? '+' : '−'}${fmt(t.valor)}</div></li>`).join('');
  return ul;
}

function card(titulo, conteudo, extra = '') {
  const c = document.createElement('div'); c.className = 'card' + (extra ? ' ' + extra : '');
  if (titulo) c.innerHTML = `<h2>${titulo}</h2>`;
  if (typeof conteudo === 'string') c.insertAdjacentHTML('beforeend', conteudo); else if (conteudo) c.appendChild(conteudo);
  return c;
}

// ---------------- abas ----------------
function renderResumo() {
  const el = $('#aba-resumo'); el.innerHTML = '';
  const meses = mesesDisponiveis();
  const atual = meses.at(-1), anterior = meses.at(-2);
  const gAtual = somar(gastosDoMes(atual));
  const diaHoje = new Date().getDate();
  const gAntMesmoDia = anterior ? somar(gastosDoMes(anterior).filter((t) => +t.data.slice(8, 10) <= diaHoje)) : 0;
  const receitas = somar(D.transacoes.filter((t) => ehReceita(t) && mesChave(t.data) === atual));
  const saldo = D.contas.filter((c) => c.tipo === 'conta').reduce((s, c) => s + c.saldo, 0);
  const faturas = D.contas.filter((c) => c.tipo === 'cartao').reduce((s, c) => s + c.saldo, 0);
  const investido = todosInvestimentos().reduce((s, i) => s + (i.saldo || 0), 0);

  let comp = '';
  if (gAntMesmoDia > 0) {
    const dif = (gAtual - gAntMesmoDia) / gAntMesmoDia * 100;
    comp = `<span class="${dif > 0 ? 'neg' : 'pos'}">${dif > 0 ? '▲' : '▼'} ${Math.abs(dif).toFixed(0)}%</span> vs. mesmo período de ${nomeMes(anterior, true)}`;
  }
  el.appendChild(card('', `<div class="rotulo">Gastos em ${nomeMes(atual)}</div><div class="valor">${fmt(gAtual)}</div><div class="sub">${comp}</div>`, 'hero'));

  const grade = document.createElement('div'); grade.className = 'grade-2';
  grade.append(
    card('', `<div class="rotulo">Saldo em contas</div><div class="valor">${fmt(saldo)}</div>`, 'mini'),
    card('', `<div class="rotulo">Faturas dos cartões</div><div class="valor">${fmt(faturas)}</div>`, 'mini'),
    card('', `<div class="rotulo">Entradas no mês</div><div class="valor">${fmt(receitas)}</div>`, 'mini'),
    card('', `<div class="rotulo">Investido</div><div class="valor">${fmt(investido)}</div>`, 'mini'),
  );
  el.appendChild(grade);

  const ult = meses.slice(-6);
  el.appendChild(card('Gastos por mês', graficoBarras(ult.map((m) => {
    const v = somar(gastosDoMes(m));
    return { rotulo: nomeMes(m, true), valor: v, destaque: m === atual, tip: `<div class="t-rot">${nomeMes(m)}</div><div class="t-val sens">${brl.format(v)}</div>` };
  }))));

  const cats = porCategoria(gastosDoMes(atual)).slice(0, 5);
  const cCats = card('Onde você mais gastou este mês', cats.length ? barrasCategorias(cats, gAtual) : '<p class="vazio">Sem gastos ainda este mês.</p>');
  const ver = document.createElement('button'); ver.className = 'btn-link'; ver.textContent = 'Ver todos os gastos →';
  ver.onclick = () => trocarAba('gastos');
  cCats.appendChild(ver);
  el.appendChild(cCats);

  const contas = document.createElement('ul'); contas.className = 'lista';
  contas.innerHTML = D.contas.map((c) => `<li><div class="esq"><div class="nome">${esc(c.nome)}</div>
    <div class="det">${esc(c.instituicao)}${c.tipo === 'cartao' && c.limiteDisponivel != null ? ` · limite disponível <span class="sens">${brl.format(c.limiteDisponivel)}</span>` : ''}</div></div>
    <div class="dir">${c.tipo === 'cartao' ? '<span class="det">fatura </span>' : ''}${fmt(c.saldo)}</div></li>`).join('');
  el.appendChild(card('Contas e cartões', contas));

  el.appendChild(card('Últimas movimentações', listaTransacoes(D.transacoes, 8)));
}

function renderGastos() {
  const el = $('#aba-gastos'); el.innerHTML = '';
  const meses = mesesDisponiveis();
  if (!mesSel || !meses.includes(mesSel)) mesSel = meses.at(-1);
  const i = meses.indexOf(mesSel);

  const sel = document.createElement('div'); sel.className = 'seletor';
  sel.innerHTML = `<button aria-label="Mês anterior" ${i <= 0 ? 'disabled' : ''}>‹</button><span class="mes">${nomeMes(mesSel).replace(/^./, (c) => c.toUpperCase())}</span><button aria-label="Próximo mês" ${i >= meses.length - 1 ? 'disabled' : ''}>›</button>`;
  const [ant, prox] = sel.querySelectorAll('button');
  ant.onclick = () => { mesSel = meses[i - 1]; catAberta = null; renderGastos(); };
  prox.onclick = () => { mesSel = meses[i + 1]; catAberta = null; renderGastos(); };
  el.appendChild(sel);

  const lista = gastosDoMes(mesSel);
  const total = somar(lista);
  const nTx = lista.length;
  const anteriorTotal = i > 0 ? somar(gastosDoMes(meses[i - 1])) : 0;
  let comp = `${nTx} compra${nTx === 1 ? '' : 's'}`;
  if (anteriorTotal > 0 && i < meses.length - 1) {
    const dif = (total - anteriorTotal) / anteriorTotal * 100;
    comp += ` · <span class="${dif > 0 ? 'neg' : 'pos'}">${dif > 0 ? '▲' : '▼'} ${Math.abs(dif).toFixed(0)}%</span> vs. ${nomeMes(meses[i - 1], true)}`;
  }
  el.appendChild(card('', `<div class="rotulo">Total gasto</div><div class="valor">${fmt(total)}</div><div class="sub">${comp}</div>`, 'hero'));

  const cats = porCategoria(lista);
  el.appendChild(card('Por categoria <span class="muted small">(toque para ver as compras)</span>',
    cats.length ? barrasCategorias(cats, total, mesSel) : '<p class="vazio">Nenhum gasto neste mês.</p>'));

  const maiores = [...lista].sort((a, b) => b.valor - a.valor);
  el.appendChild(card('Maiores gastos', listaTransacoes(maiores, 6)));

  // gasto por estabelecimento
  const porLoja = new Map();
  for (const t of lista) {
    const o = porLoja.get(t.descricao) || { v: 0, n: 0 };
    o.v += t.valor; o.n++; porLoja.set(t.descricao, o);
  }
  const lojas = [...porLoja.entries()].sort((a, b) => b[1].v - a[1].v).slice(0, 6);
  if (lojas.length) {
    const ul = document.createElement('ul'); ul.className = 'lista';
    ul.innerHTML = lojas.map(([n, o]) => `<li><div class="esq"><div class="nome">${esc(n)}</div><div class="det">${o.n} vez${o.n > 1 ? 'es' : ''}</div></div><div class="dir">${fmt(o.v)}</div></li>`).join('');
    el.appendChild(card('Onde mais vai seu dinheiro', ul));
  }
}

function renderInvestimentos() {
  const el = $('#aba-investimentos'); el.innerHTML = '';
  const invs = todosInvestimentos();
  const total = invs.reduce((s, i) => s + (i.saldo || 0), 0);
  const comAplicado = invs.filter((i) => i.aplicado != null);
  const rend = comAplicado.reduce((s, i) => s + (i.saldo - i.aplicado), 0);
  const aplic = comAplicado.reduce((s, i) => s + i.aplicado, 0);
  const sub = comAplicado.length
    ? `Rendimento <span class="${rend >= 0 ? 'pos' : 'neg'} sens">${rend >= 0 ? '+' : '−'}${brl.format(Math.abs(rend))}</span>${aplic ? ` (${(rend / aplic * 100).toFixed(1).replace('.', ',')}%)` : ''}`
    : `${invs.length} aplicaç${invs.length === 1 ? 'ão' : 'ões'}`;
  el.appendChild(card('', `<div class="rotulo">Patrimônio investido</div><div class="valor">${fmt(total)}</div><div class="sub">${sub}</div>`, 'hero'));

  const hist = (D.historico || []).filter((h) => h.investido > 0);
  if (hist.length >= 2) {
    el.appendChild(card('Evolução <span class="muted small">(dados do Open Finance)</span>', graficoLinha(hist.map((h) => ({ data: h.data, valor: h.investido })))));
  } else {
    el.appendChild(card('Evolução', '<p class="vazio">O gráfico aparece depois de alguns dias de atualizações: o app guarda uma foto do patrimônio a cada coleta.</p>'));
  }

  // distribuição por tipo
  const porTipo = new Map();
  for (const i of invs) { const k = TIPOS_INV[i.tipo] || 'Outros'; porTipo.set(k, (porTipo.get(k) || 0) + (i.saldo || 0)); }
  const tipos = [...porTipo.entries()].sort((a, b) => b[1] - a[1]);
  if (tipos.length) el.appendChild(card('Distribuição', barrasCategorias(tipos, total)));

  const ul = document.createElement('ul'); ul.className = 'lista';
  ul.innerHTML = invs.length ? [...invs].sort((a, b) => b.saldo - a.saldo).map((i) => {
    const r = i.aplicado != null ? i.saldo - i.aplicado : i.rendimento;
    return `<li><div class="esq"><div class="nome">${esc(i.nome)}${i.manual ? '<span class="chip">manual</span>' : ''}</div>
      <div class="det">${esc(TIPOS_INV[i.tipo] || 'Outros')}${i.taxa ? ' · ' + esc(i.taxa) : ''}${i.vencimento ? ' · vence ' + dataCurta(i.vencimento) + '/' + i.vencimento.slice(0, 4) : ''}${i.manual ? ` · <button class="btn-link" data-del="${esc(i.id)}" style="padding:0">remover</button>` : ''}</div></div>
      <div class="dir">${fmt(i.saldo)}${r != null ? `<div class="det ${r >= 0 ? 'pos' : 'neg'} sens">${r >= 0 ? '+' : '−'}${brl.format(Math.abs(r))}</div>` : ''}</div></li>`;
  }).join('') : '<li class="vazio">Nenhum investimento encontrado pelo Open Finance.</li>';
  ul.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => {
    store.set('fin_manuais', JSON.stringify(investimentosManuais().filter((x) => x.id !== b.dataset.del)));
    renderInvestimentos();
  });
  const c = card('Suas aplicações', ul);
  const add = document.createElement('button'); add.className = 'btn-link'; add.textContent = '+ Adicionar investimento manual';
  add.onclick = () => { $('#form-manual').reset(); $('#dlg-manual').showModal(); };
  c.appendChild(add);
  el.appendChild(c);
}

const RENDER = { resumo: renderResumo, gastos: renderGastos, investimentos: renderInvestimentos };
const TITULOS = { resumo: 'Resumo', gastos: 'Gastos', investimentos: 'Investimentos' };
function trocarAba(aba) {
  document.querySelectorAll('.abas button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.aba === aba)));
  for (const k of Object.keys(RENDER)) $('#aba-' + k).hidden = k !== aba;
  $('#titulo').textContent = TITULOS[aba];
  RENDER[aba]();
  esconderTip();
  scrollTo(0, 0);
  store.set('fin_aba', aba);
}

function iniciarApp() {
  $('#bloqueio').hidden = true; $('#app').hidden = false;
  const quando = new Date(D.geradoEm);
  $('#atualizado').textContent = `Atualizado ${quando.toLocaleDateString('pt-BR')} às ${quando.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}${D.demo ? ' · demonstração' : ''}`;
  $('#avisos').innerHTML = (D.avisos || []).map((a) => `<div class="aviso">⚠️ <span>${esc(a)}</span></div>`).join('');
  trocarAba(store.get('fin_aba') || 'resumo');
}

// ---------------- eventos ----------------
$('#form-senha').addEventListener('submit', (e) => { e.preventDefault(); abrir($('#senha').value, $('#lembrar').checked); });
document.querySelectorAll('.abas button').forEach((b) => b.addEventListener('click', () => trocarAba(b.dataset.aba)));
$('#btn-olho').addEventListener('click', () => {
  const o = document.body.classList.toggle('oculto');
  store.set('fin_oculto', o ? '1' : '');
});
if (store.get('fin_oculto')) document.body.classList.add('oculto');

$('#form-manual').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'ok') return;
  const f = new FormData(e.target);
  const num = (s) => { const v = parseFloat(String(s || '').replace(/\./g, '').replace(',', '.')); return isNaN(v) ? null : v; };
  const saldo = num(f.get('saldo'));
  if (saldo == null) { e.preventDefault(); return; }
  const lista = investimentosManuais();
  lista.push({ id: 'm' + Date.now(), nome: f.get('nome'), tipo: f.get('tipo'), saldo, aplicado: num(f.get('aplicado')) });
  store.set('fin_manuais', JSON.stringify(lista));
  setTimeout(renderInvestimentos, 0);
});

// atualiza ao voltar para o app (se já desbloqueado)
document.addEventListener('visibilitychange', () => {
  const s = store.get('fin_senha');
  if (document.visibilityState === 'visible' && D && s && Date.now() - carregadoEm > 10 * 60 * 1000) abrir(s, true);
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

const salva = store.get('fin_senha');
if (salva) { $('#bloqueio').hidden = true; abrir(salva, true); }
