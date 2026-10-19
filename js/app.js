/* Cobranças PMO – aplicação (sem dados pessoais do contribuinte) */
(() => {
'use strict';

// ---------------------------------------------------------------- utilidades
const CFG = window.APP_CONFIG || {};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const NUM = new Intl.NumberFormat('pt-BR');
const DEC = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const PCT = new Intl.NumberFormat('pt-BR', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MES_ABR = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const CATEGORIAS = ['Pago', 'Em andamento', 'Revogado', 'Outros', 'Sem situação'];
const OPC = {
  fonte: ['Cadastro', 'Localize', 'Assertiva', 'Informado pelo contribuinte'],
  whatsapp: ['Enviado', 'Respondido', 'Sem WhatsApp'],
  sms: ['Enviado', 'Respondido'],
  ligacao: ['Atendida', 'Não atendida', 'Número errado']
};
const RE_ID = /^[0-9A-Za-z./-]{1,30}$/;

const hoje = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const fmtData = iso => { if (!iso) return ''; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const dt = iso => new Date(String(iso).slice(0, 10) + 'T12:00:00Z');
const isoDe = d => d.toISOString().slice(0, 10);
const addDias = (iso, n) => { const d = dt(iso); d.setUTCDate(d.getUTCDate() + n); return isoDe(d); };
const diaSemana = iso => SEMANA[dt(iso).getUTCDay()];
const ultimoDia = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m = 1..12
const pad = n => String(n).padStart(2, '0');
const catClass = c => (c || 'Sem situação').replace('Sem situação', 'Sem-situacao').replace(' ', '-');
const tag = c => `<span class="tag ${catClass(c)}">${esc(c || 'Sem situação')}</span>`;
const div0 = (a, b) => (b ? a / b : 0);
const parseValor = s => {
  s = String(s ?? '').trim().replace(/[R$\s]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
};
const fmtValorInput = v => (v == null ? '' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function toast(msg, erro = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (erro ? ' erro' : ''); t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), erro ? 7000 : 3500);
}
function msgErro(e) {
  const m = (e && (e.message || e.error_description || e.msg)) || String(e);
  const mapa = [
    [/Invalid login credentials/i, 'E-mail ou senha incorretos.'],
    [/Email not confirmed/i, 'Seu e-mail ainda não foi confirmado. Verifique sua caixa de entrada (e o spam).'],
    [/User already registered/i, 'Este e-mail já está cadastrado. Use "Entrar" ou "Esqueci a senha".'],
    [/Password should be at least|weak/i, 'Senha fraca. Use pelo menos 10 caracteres, misturando letras e números.'],
    [/rate limit|too many/i, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.'],
    [/row-level security|permission denied/i, 'Você não tem permissão para esta ação.'],
    [/lancamentos_id_parcelamento_check/i, 'Id do parcelamento inválido: use apenas números/letras, sem espaços (nada de nomes).'],
    [/lancamentos_origem_check/i, 'Origem/inscrição inválida: use apenas números/letras, sem espaços.'],
    [/Failed to fetch|NetworkError/i, 'Sem conexão com o servidor. Verifique sua internet.'],
    [/Invalid TOTP|invalid.*code/i, 'Código inválido. Confira o horário do celular e tente novamente.']
  ];
  for (const [re, txt] of mapa) if (re.test(m)) return txt;
  return m;
}

// ---------------------------------------------------------------- Supabase
if (!CFG.SUPABASE_URL || /SEU-PROJETO/.test(CFG.SUPABASE_URL)) {
  $('#app').innerHTML = '<div class="card"><h2>Configuração pendente</h2><p>Preencha <code>js/config.js</code> com a URL e a chave pública do projeto Supabase.</p></div>';
  return;
}
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
  auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const S = { user: null, perfil: null, situacoes: [], setores: [], perfis: [], charts: [], recuperando: false };
const ehSup = () => S.perfil && ['supervisor', 'admin'].includes(S.perfil.papel);
const ehAdmin = () => S.perfil && S.perfil.papel === 'admin';
const catDe = cod => (cod ? (S.situacoes.find(s => s.codigo === cod)?.categoria || 'Outros') : 'Sem situação');
const app = () => $('#app');

// ---------------------------------------------------------------- inatividade
let timerInativo;
function resetInatividade() {
  clearTimeout(timerInativo);
  if (!S.user) return;
  timerInativo = setTimeout(async () => {
    await sb.auth.signOut();
    toast('Sessão encerrada por inatividade.');
  }, (CFG.INATIVIDADE_MIN || 30) * 60 * 1000);
}
['click', 'keydown', 'mousemove', 'touchstart', 'scroll'].forEach(ev => document.addEventListener(ev, resetInatividade, { passive: true }));

// ---------------------------------------------------------------- fluxo de sessão
async function iniciar() {
  sb.auth.onAuthStateChange((evento, sessao) => {
    if (evento === 'PASSWORD_RECOVERY') { S.recuperando = true; telaNovaSenha(); return; }
    if (evento === 'SIGNED_OUT') { S.user = null; S.perfil = null; $('#topo').hidden = true; telaLogin(); }
  });
  const { data: { session } } = await sb.auth.getSession();
  if (S.recuperando) return;
  await aposLogin(session);
}

async function aposLogin(session) {
  if (!session) { $('#topo').hidden = true; return telaLogin(); }
  S.user = session.user;
  const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') return telaDesafioMfa();
  const { data: perfil, error } = await sb.from('perfis').select('*').eq('id', S.user.id).maybeSingle();
  if (error) { app().innerHTML = `<div class="card aviso erro">${esc(msgErro(error))}</div>`; return; }
  S.perfil = perfil;
  if (!perfil || !perfil.ativo) return telaAguardando();
  await carregarTabelas();
  $('#topo').hidden = false;
  $('#nomeUsuario').textContent = `${perfil.nome} · ${({ funcionario: 'Funcionário', supervisor: 'Supervisão', admin: 'Administrador' })[perfil.papel]}`;
  $('#menuAdmin').hidden = !ehAdmin();
  resetInatividade();
  if (!location.hash || location.hash === '#/') location.hash = '#/lancar'; else rotear();
}

async function carregarTabelas() {
  const [sit, set] = await Promise.all([
    sb.from('situacoes').select('*').order('ordem').order('codigo'),
    sb.from('setores').select('*').order('ordem').order('nome')
  ]);
  S.situacoes = sit.data || []; S.setores = set.data || [];
  if (ehSup()) {
    const { data } = await sb.from('perfis').select('id,nome,email,papel,ativo').order('nome');
    S.perfis = data || [];
  } else S.perfis = [S.perfil];
}

$('#btnSair').addEventListener('click', () => sb.auth.signOut());

// ---------------------------------------------------------------- telas de acesso
function telaLogin(aba = 'entrar', aviso = '') {
  destruirGraficos();
  app().innerHTML = `
  <div class="tela-login">
    <div class="marca-g"><h1>Cobranças PMO</h1><p class="sub">Controle diário de cobranças e relatórios</p></div>
    <div class="card">
      <div class="abas" role="tablist">
        <button type="button" data-aba="entrar" class="${aba === 'entrar' ? 'ativo' : ''}">Entrar</button>
        <button type="button" data-aba="cadastro" class="${aba === 'cadastro' ? 'ativo' : ''}">Solicitar acesso</button>
        <button type="button" data-aba="senha" class="${aba === 'senha' ? 'ativo' : ''}">Esqueci a senha</button>
      </div>
      ${aviso}
      <div id="abaConteudo"></div>
    </div>
    <p class="dica" style="text-align:center">Acesso restrito a servidores autorizados. Não registre nome, CPF ou telefone de contribuintes.</p>
  </div>`;
  $$('.abas button').forEach(b => b.addEventListener('click', () => telaLogin(b.dataset.aba)));
  const c = $('#abaConteudo');
  if (aba === 'entrar') {
    c.innerHTML = `<form class="form-col" id="fLogin">
      <label class="campo">E-mail<input type="email" name="email" autocomplete="username" required></label>
      <label class="campo">Senha<input type="password" name="senha" autocomplete="current-password" required></label>
      <button class="btn prim" type="submit">Entrar</button></form>`;
    $('#fLogin').addEventListener('submit', async e => {
      e.preventDefault(); const f = e.target; const b = f.querySelector('button'); b.disabled = true;
      const { data, error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.senha.value });
      b.disabled = false;
      if (error) return toast(msgErro(error), true);
      aposLogin(data.session);
    });
  } else if (aba === 'cadastro') {
    c.innerHTML = `<form class="form-col" id="fCad">
      <label class="campo">Seu nome (como aparecerá nos relatórios)<input name="nome" required minlength="2" maxlength="80" autocomplete="name"></label>
      <label class="campo">E-mail<input type="email" name="email" required autocomplete="email"></label>
      <label class="campo">Senha (mínimo 10 caracteres)<input type="password" name="senha" required minlength="10" autocomplete="new-password"></label>
      <label class="campo">Repita a senha<input type="password" name="senha2" required minlength="10" autocomplete="new-password"></label>
      <button class="btn prim" type="submit">Solicitar acesso</button>
      <p class="dica">Depois do cadastro, o administrador precisa liberar seu acesso.</p></form>`;
    $('#fCad').addEventListener('submit', async e => {
      e.preventDefault(); const f = e.target;
      if (f.senha.value !== f.senha2.value) return toast('As senhas não conferem.', true);
      const b = f.querySelector('button'); b.disabled = true;
      const { data, error } = await sb.auth.signUp({ email: f.email.value.trim(), password: f.senha.value,
        options: { data: { nome: f.nome.value.trim() }, emailRedirectTo: location.origin + location.pathname } });
      b.disabled = false;
      if (error) return toast(msgErro(error), true);
      if (data.session) return aposLogin(data.session);
      telaLogin('entrar', '<div class="aviso ok">Cadastro enviado! Se pedirmos, confirme pelo link enviado ao seu e-mail. Depois, aguarde o administrador liberar o acesso.</div>');
    });
  } else {
    c.innerHTML = `<form class="form-col" id="fSenha">
      <label class="campo">E-mail cadastrado<input type="email" name="email" required autocomplete="email"></label>
      <button class="btn prim" type="submit">Enviar link de redefinição</button></form>`;
    $('#fSenha').addEventListener('submit', async e => {
      e.preventDefault(); const f = e.target;
      const { error } = await sb.auth.resetPasswordForEmail(f.email.value.trim(), { redirectTo: location.origin + location.pathname });
      if (error) return toast(msgErro(error), true);
      telaLogin('entrar', '<div class="aviso ok">Se o e-mail estiver cadastrado, você receberá um link para criar nova senha.</div>');
    });
  }
}

function telaNovaSenha() {
  $('#topo').hidden = true;
  app().innerHTML = `<div class="tela-login"><div class="card"><h2>Criar nova senha</h2>
    <form class="form-col" id="fNova">
      <label class="campo">Nova senha (mínimo 10 caracteres)<input type="password" name="senha" minlength="10" required autocomplete="new-password"></label>
      <label class="campo">Repita a nova senha<input type="password" name="senha2" minlength="10" required autocomplete="new-password"></label>
      <button class="btn prim">Salvar nova senha</button></form></div></div>`;
  $('#fNova').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    if (f.senha.value !== f.senha2.value) return toast('As senhas não conferem.', true);
    const { error } = await sb.auth.updateUser({ password: f.senha.value });
    if (error) return toast(msgErro(error), true);
    S.recuperando = false; toast('Senha alterada.');
    history.replaceState(null, '', location.pathname);
    const { data: { session } } = await sb.auth.getSession(); aposLogin(session);
  });
}

async function telaDesafioMfa() {
  $('#topo').hidden = true;
  const { data } = await sb.auth.mfa.listFactors();
  const fator = (data?.totp || []).find(f => f.status === 'verified');
  app().innerHTML = `<div class="tela-login"><div class="card"><h2>Verificação em duas etapas</h2>
    <p class="sub">Digite o código de 6 dígitos do seu aplicativo autenticador.</p>
    <form class="form-col" id="fMfa">
      <label class="campo">Código<input name="codigo" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required autofocus></label>
      <button class="btn prim">Confirmar</button>
      <button type="button" class="btn ghost" id="mfaSair">Sair</button></form></div></div>`;
  $('#mfaSair').addEventListener('click', () => sb.auth.signOut());
  $('#fMfa').addEventListener('submit', async e => {
    e.preventDefault();
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: fator.id, code: e.target.codigo.value.trim() });
    if (error) return toast(msgErro(error), true);
    const { data: { session } } = await sb.auth.getSession(); aposLogin(session);
  });
}

function telaAguardando() {
  $('#topo').hidden = true;
  app().innerHTML = `<div class="tela-login"><div class="card"><h2>Acesso aguardando liberação</h2>
    <p>Olá${S.perfil ? ', ' + esc(S.perfil.nome) : ''}! Seu cadastro foi recebido. O administrador precisa liberar seu acesso.</p>
    <p class="sub">Depois de liberado, saia e entre novamente.</p>
    <div class="acoes"><button class="btn" id="tentar">Verificar novamente</button><button class="btn ghost" id="sairAg">Sair</button></div></div></div>`;
  $('#tentar').addEventListener('click', async () => { const { data: { session } } = await sb.auth.getSession(); aposLogin(session); });
  $('#sairAg').addEventListener('click', () => sb.auth.signOut());
}

// ---------------------------------------------------------------- roteamento
function parseHash() {
  const [rota, qs] = location.hash.replace(/^#\/?/, '').split('?');
  return { rota: rota || 'lancar', params: Object.fromEntries(new URLSearchParams(qs || '')) };
}
function rotear() {
  if (!S.perfil || !S.perfil.ativo || S.recuperando) return;
  const { rota, params } = parseHash();
  $$('#menu a').forEach(a => a.classList.toggle('ativo', a.dataset.rota === rota));
  destruirGraficos();
  const telas = { lancar: telaLancar, pendentes: telaPendentes, relatorios: telaRelatorios, admin: telaAdmin, conta: telaConta };
  (telas[rota] || telaLancar)(params);
  app().focus({ preventScroll: true });
}
window.addEventListener('hashchange', rotear);

// ---------------------------------------------------------------- LANÇAR
const optList = (lista, sel, vazio = '—') => `<option value="">${vazio}</option>` + lista.map(v => `<option ${v === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
function optSituacoes(sel) {
  const ativos = S.situacoes.filter(s => s.ativo || s.codigo === sel);
  return '<option value="">— (ainda sem situação)</option>' + CATEGORIAS.slice(0, 4).map(cat => {
    const itens = ativos.filter(s => s.categoria === cat);
    return itens.length ? `<optgroup label="${esc(cat)}">${itens.map(s => `<option value="${esc(s.codigo)}" ${s.codigo === sel ? 'selected' : ''}>${esc(s.codigo)}</option>`).join('')}</optgroup>` : '';
  }).join('');
}

async function telaLancar(params) {
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(params.data || '') ? params.data : hoje();
  const setores = S.setores.filter(s => s.ativo).map(s => s.nome);
  app().innerHTML = `
  <div class="cab">
    <div><h1>Lançamentos do dia</h1><p class="sub">Cada contribuinte contatado = uma linha. Quando a situação mudar, atualize a mesma linha.</p></div>
    <div class="barra-dia">
      <button class="btn" id="diaAnt" title="Dia anterior" aria-label="Dia anterior">‹</button>
      <input type="date" id="dia" value="${dia}" aria-label="Data do contato">
      <button class="btn" id="diaProx" title="Próximo dia" aria-label="Próximo dia">›</button>
      <button class="btn" id="diaHoje">Hoje</button>
      <span class="dia-semana">${diaSemana(dia)}</span>
    </div>
  </div>
  <div class="kpis mini" id="resumoDia"></div>
  <form class="card" id="fLanc" novalidate autocomplete="off">
    <div class="cab"><h2 id="tituloForm">Novo lançamento</h2><span class="dica">Campos com * são obrigatórios</span></div>
    <input type="hidden" name="registro">
    <fieldset><legend>Identificação</legend><div class="grade">
      <label class="campo"><span class="obrig">Id do parcelamento</span><input name="id_parcelamento" required maxlength="30" inputmode="numeric" placeholder="ex.: 103800"></label>
      <label class="campo">Setor<select name="setor">${optList(setores)}</select></label>
      <label class="campo">Origem / inscrição<input name="origem" maxlength="30" placeholder="ex.: 62902"></label>
      <label class="campo">Fonte do contato<select name="fonte_contato">${optList(OPC.fonte)}</select></label>
    </div><div id="avisoDup"></div></fieldset>
    <fieldset><legend>Ações realizadas</legend><div class="grade">
      <label class="campo">WhatsApp<select name="whatsapp">${optList(OPC.whatsapp)}</select></label>
      <label class="campo">SMS<select name="sms">${optList(OPC.sms)}</select></label>
      <label class="campo">Ligação<select name="ligacao">${optList(OPC.ligacao)}</select></label>
      <label class="campo">Agendamento (data)<input type="date" name="agendamento"></label>
      <label class="campo">Boleto emitido em<input type="date" name="boleto_emitido"></label>
      <label class="campo">Nº de parcelas<input type="number" name="parcelas" min="1" max="240" step="1"></label>
    </div></fieldset>
    <fieldset><legend>Resultado</legend><div class="grade">
      <label class="campo largo">Situação<select name="situacao">${optSituacoes()}</select><span class="dica" id="descSit"></span></label>
      <label class="campo">Valor pago (R$)<input name="valor_pago" inputmode="decimal" placeholder="0,00"></label>
      <label class="campo largo">Observações <span class="dica">— não escreva nome, CPF ou telefone do contribuinte</span><textarea name="observacoes" maxlength="500"></textarea></label>
    </div></fieldset>
    <div class="acoes">
      <button class="btn prim" type="submit" id="btnSalvar">Salvar lançamento</button>
      <button class="btn" type="button" id="btnLimpar">Limpar / cancelar edição</button>
    </div>
  </form>
  <div class="card"><div class="cab"><h2>Contatos de ${fmtData(dia)}</h2><span class="dica" id="qtdDia"></span></div>
    <div class="tabela-wrap"><table><thead><tr>
      <th>Nº</th><th>Id parc.</th><th>Setor</th><th>Ações</th><th>Boleto</th><th>Situação</th><th class="num">Valor</th><th>Observações</th><th></th>
    </tr></thead><tbody id="tbDia"><tr><td colspan="9" class="vazio">Carregando…</td></tr></tbody></table></div></div>`;

  const irDia = d => { location.hash = `#/lancar?data=${d}`; };
  $('#dia').addEventListener('change', e => e.target.value && irDia(e.target.value));
  $('#diaAnt').addEventListener('click', () => irDia(addDias(dia, -1)));
  $('#diaProx').addEventListener('click', () => irDia(addDias(dia, 1)));
  $('#diaHoje').addEventListener('click', () => irDia(hoje()));

  const f = $('#fLanc');
  const limpar = () => { f.reset(); f.registro.value = ''; $('#tituloForm').textContent = 'Novo lançamento'; $('#btnSalvar').textContent = 'Salvar lançamento'; $('#avisoDup').innerHTML = ''; $('#descSit').textContent = ''; };
  $('#btnLimpar').addEventListener('click', limpar);
  f.situacao.addEventListener('change', () => { $('#descSit').textContent = S.situacoes.find(s => s.codigo === f.situacao.value)?.descricao || ''; });
  f.id_parcelamento.addEventListener('blur', () => verificarDuplicado(f));
  f.valor_pago.addEventListener('blur', () => { const v = parseValor(f.valor_pago.value); if (v != null && !Number.isNaN(v)) f.valor_pago.value = fmtValorInput(v); });

  f.addEventListener('submit', async e => {
    e.preventDefault();
    const o = {
      id_parcelamento: f.id_parcelamento.value.trim(), setor: f.setor.value || null, origem: f.origem.value.trim() || null,
      fonte_contato: f.fonte_contato.value || null, whatsapp: f.whatsapp.value || null, sms: f.sms.value || null,
      ligacao: f.ligacao.value || null, agendamento: f.agendamento.value || null, boleto_emitido: f.boleto_emitido.value || null,
      parcelas: f.parcelas.value ? Number(f.parcelas.value) : null, situacao: f.situacao.value || null,
      valor_pago: parseValor(f.valor_pago.value), observacoes: f.observacoes.value.trim() || null
    };
    if (!RE_ID.test(o.id_parcelamento)) { f.id_parcelamento.setAttribute('aria-invalid', 'true'); f.id_parcelamento.focus(); return toast('Informe o Id do parcelamento (só números/letras, sem espaços).', true); }
    f.id_parcelamento.removeAttribute('aria-invalid');
    if (o.origem && !RE_ID.test(o.origem)) return toast('Origem/inscrição: use só números/letras, sem espaços.', true);
    if (Number.isNaN(o.valor_pago)) return toast('Valor pago inválido. Exemplo: 388,15', true);
    if (o.parcelas != null && !(Number.isInteger(o.parcelas) && o.parcelas >= 1 && o.parcelas <= 240)) return toast('Nº de parcelas deve ser um número inteiro de 1 a 240.', true);
    const cat = catDe(o.situacao);
    if (cat === 'Pago' && o.valor_pago == null && !confirm('Situação "pago" sem valor informado. Salvar mesmo assim?')) return;
    if (cat !== 'Pago' && o.valor_pago != null && !confirm('Há valor pago, mas a situação não é de pagamento. Salvar mesmo assim?')) return;
    if (/\b\d{2}\s?9?\d{4}-?\d{4}\b|\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(o.observacoes || '') &&
        !confirm('As observações parecem conter telefone ou CPF. Dados pessoais não devem ser registrados aqui. Salvar mesmo assim?')) return;
    const b = $('#btnSalvar'); b.disabled = true;
    const id = f.registro.value;
    const r = id ? await sb.from('lancamentos').update(o).eq('id', id)
                 : await sb.from('lancamentos').insert({ ...o, data_contato: dia });
    b.disabled = false;
    if (r.error) return toast(msgErro(r.error), true);
    toast(id ? 'Lançamento atualizado.' : 'Lançamento salvo.');
    limpar(); await carregarDia(dia); f.id_parcelamento.focus();
  });

  await carregarDia(dia);
  if (params.editar) {
    const { data } = await sb.from('lancamentos').select('*').eq('id', params.editar).maybeSingle();
    if (data) editar(data);
  }
}

function editar(l) {
  const f = $('#fLanc'); if (!f) return;
  f.registro.value = l.id;
  for (const k of ['id_parcelamento', 'origem', 'agendamento', 'boleto_emitido', 'parcelas', 'observacoes']) f[k].value = l[k] ?? '';
  for (const k of ['setor', 'fonte_contato', 'whatsapp', 'sms', 'ligacao']) {
    if (l[k] && ![...f[k].options].some(o => o.value === l[k])) f[k].insertAdjacentHTML('beforeend', `<option>${esc(l[k])}</option>`);
    f[k].value = l[k] ?? '';
  }
  f.situacao.innerHTML = optSituacoes(l.situacao); f.situacao.value = l.situacao ?? '';
  $('#descSit').textContent = S.situacoes.find(s => s.codigo === l.situacao)?.descricao || '';
  f.valor_pago.value = fmtValorInput(l.valor_pago);
  $('#tituloForm').textContent = `Editando lançamento – Id ${l.id_parcelamento}`;
  $('#btnSalvar').textContent = 'Salvar alterações';
  $('#avisoDup').innerHTML = '';
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function verificarDuplicado(f) {
  const v = f.id_parcelamento.value.trim(); const box = $('#avisoDup'); box.innerHTML = '';
  if (!RE_ID.test(v)) return;
  let q = sb.from('lancamentos').select('id,data_contato,situacao').eq('funcionario_id', S.user.id).eq('id_parcelamento', v)
    .order('data_contato', { ascending: false }).limit(3);
  if (f.registro.value) q = q.neq('id', f.registro.value);
  const { data } = await q;
  if (data && data.length) {
    box.innerHTML = `<div class="aviso atencao">Este parcelamento já foi lançado por você: ${data.map(d =>
      `<a href="#/lancar?data=${d.data_contato}&editar=${d.id}">${fmtData(d.data_contato)} (${esc(d.situacao || 'sem situação')})</a>`).join(', ')}.
      Se for o mesmo caso, atualize aquele registro em vez de lançar de novo.</div>`;
  }
}

async function carregarDia(dia) {
  const { data, error } = await sb.from('lancamentos').select('*').eq('funcionario_id', S.user.id).eq('data_contato', dia).order('id');
  const tb = $('#tbDia'); if (!tb) return;
  if (error) { tb.innerHTML = `<tr><td colspan="9" class="vazio">${esc(msgErro(error))}</td></tr>`; return; }
  const rows = data || [];
  const cont = c => rows.filter(r => catDe(r.situacao) === c).length;
  const valor = rows.filter(r => catDe(r.situacao) === 'Pago').reduce((a, r) => a + Number(r.valor_pago || 0), 0);
  $('#resumoDia').innerHTML = [
    ['Contatos', rows.length], ['Boletos', rows.filter(r => r.boleto_emitido).length], ['Pagos', cont('Pago')],
    ['Em andamento', cont('Em andamento')], ['Revogados', cont('Revogado')], ['Sem situação', cont('Sem situação')], ['Valor arrecadado', BRL.format(valor)]
  ].map(([r, v]) => `<div class="kpi"><div class="rot">${r}</div><div class="val">${typeof v === 'number' ? NUM.format(v) : v}</div></div>`).join('');
  $('#qtdDia').textContent = `${rows.length} contato(s)`;
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="9" class="vazio">Nenhum contato lançado neste dia.</td></tr>'; return; }
  tb.innerHTML = rows.map((r, i) => {
    const acoes = [r.whatsapp && `WhatsApp: ${r.whatsapp}`, r.sms && `SMS: ${r.sms}`, r.ligacao && `Ligação: ${r.ligacao}`, r.agendamento && `Agend.: ${fmtData(r.agendamento)}`].filter(Boolean);
    return `<tr><td>${i + 1}</td><td><strong>${esc(r.id_parcelamento)}</strong>${r.origem ? `<div class="dica">Origem ${esc(r.origem)}</div>` : ''}</td>
      <td>${esc(r.setor || '')}</td><td class="dica">${acoes.map(esc).join('<br>')}</td>
      <td>${r.boleto_emitido ? fmtData(r.boleto_emitido) + (r.parcelas ? `<div class="dica">${r.parcelas} parc.</div>` : '') : ''}</td>
      <td>${tag(catDe(r.situacao))}<div class="dica">${esc(r.situacao || '')}</div></td>
      <td class="num">${r.valor_pago != null ? BRL.format(r.valor_pago) : ''}</td>
      <td class="obs">${esc(r.observacoes || '')}</td>
      <td><div class="acoes"><button class="btn peq" data-ed="${r.id}">Editar</button><button class="btn peq perigo" data-ex="${r.id}">Excluir</button></div></td></tr>`;
  }).join('');
  $$('[data-ed]', tb).forEach(b => b.addEventListener('click', () => editar(rows.find(r => String(r.id) === b.dataset.ed))));
  $$('[data-ex]', tb).forEach(b => b.addEventListener('click', async () => {
    const r = rows.find(x => String(x.id) === b.dataset.ex);
    if (!confirm(`Excluir o lançamento do parcelamento ${r.id_parcelamento}? Esta ação fica registrada na auditoria.`)) return;
    const { error } = await sb.from('lancamentos').delete().eq('id', r.id);
    if (error) return toast(msgErro(error), true);
    toast('Lançamento excluído.'); carregarDia(dia);
  }));
}

// ---------------------------------------------------------------- PENDENTES
async function telaPendentes() {
  app().innerHTML = `<div class="cab"><div><h1>Pendentes</h1><p class="sub">Seus lançamentos ainda "em andamento" ou sem situação. Atualize-os à medida que houver retorno.</p></div>
    <div class="acoes"><label class="campo">Mostrar<select id="filtroPend"><option value="todos">Todos os pendentes</option><option value="and">Só "Em andamento"</option><option value="sem">Só "Sem situação"</option></select></label></div></div>
    <div class="card"><div class="tabela-wrap"><table><thead><tr><th>Data do contato</th><th class="num">Dias</th><th>Id parc.</th><th>Setor</th><th>Situação</th><th>Agendamento</th><th>Boleto</th><th>Observações</th><th></th></tr></thead>
    <tbody id="tbPend"><tr><td colspan="9" class="vazio">Carregando…</td></tr></tbody></table></div></div>`;
  const codsAnd = S.situacoes.filter(s => s.categoria === 'Em andamento').map(s => `"${s.codigo.replace(/"/g, '')}"`);
  const { data, error } = await sb.from('lancamentos').select('*').eq('funcionario_id', S.user.id)
    .or(`situacao.is.null${codsAnd.length ? `,situacao.in.(${codsAnd.join(',')})` : ''}`)
    .order('data_contato').order('id').limit(1000);
  const tb = $('#tbPend');
  if (error) { tb.innerHTML = `<tr><td colspan="9" class="vazio">${esc(msgErro(error))}</td></tr>`; return; }
  const desenhar = () => {
    const filtro = $('#filtroPend').value;
    const rows = (data || []).filter(r => filtro === 'todos' || (filtro === 'sem' ? !r.situacao : !!r.situacao));
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="9" class="vazio">Nenhuma pendência. 👍</td></tr>'; return; }
    const h = dt(hoje());
    tb.innerHTML = rows.map(r => `<tr><td>${fmtData(r.data_contato)}</td><td class="num">${Math.round((h - dt(r.data_contato)) / 864e5)}</td>
      <td><strong>${esc(r.id_parcelamento)}</strong></td><td>${esc(r.setor || '')}</td>
      <td>${tag(catDe(r.situacao))}<div class="dica">${esc(r.situacao || '')}</div></td><td>${fmtData(r.agendamento)}</td><td>${fmtData(r.boleto_emitido)}</td>
      <td class="obs">${esc(r.observacoes || '')}</td><td><a class="btn peq" href="#/lancar?data=${r.data_contato}&editar=${r.id}">Atualizar</a></td></tr>`).join('');
  };
  $('#filtroPend').addEventListener('change', desenhar); desenhar();
}

// ---------------------------------------------------------------- RELATÓRIOS
function periodo(tipo, ano, n, ini, fim) {
  ano = Number(ano); n = Number(n);
  if (tipo === 'personalizado') return { ini, fim, rotulo: `${fmtData(ini)} a ${fmtData(fim)}` };
  let m1 = 1, m2 = 12, rot = `ANO DE ${ano}`;
  if (tipo === 'mes') { m1 = m2 = n; rot = `${MESES[n - 1].toUpperCase()}/${ano}`; }
  if (tipo === 'trimestre') { m1 = 3 * n - 2; m2 = 3 * n; rot = `${n}º TRIMESTRE DE ${ano} (${MES_ABR[m1 - 1]}–${MES_ABR[m2 - 1]})`; }
  if (tipo === 'semestre') { m1 = 6 * n - 5; m2 = 6 * n; rot = `${n}º SEMESTRE DE ${ano}`; }
  return { ini: `${ano}-${pad(m1)}-01`, fim: `${ano}-${pad(m2)}-${pad(ultimoDia(ano, m2))}`, rotulo: rot };
}

function telaRelatorios(params) {
  const [ya, ma] = hoje().split('-').map(Number);
  const anos = []; for (let y = ya; y >= Math.max(2024, ya - 6); y--) anos.push(y);
  app().innerHTML = `
  <div class="cab nao-imprimir"><div><h1>Relatórios</h1><p class="sub">Escolha o período${ehSup() ? ' e o funcionário' : ''}. Tudo é calculado na hora, a partir dos lançamentos.</p></div>
    <div class="acoes"><button class="btn" id="btnImprimir">Imprimir / salvar PDF</button><button class="btn" id="btnCsv">Baixar resumo (CSV)</button></div></div>
  <form class="card nao-imprimir" id="fRel"><div class="linha">
    <label class="campo">Período<select name="tipo">
      <option value="mes">Mensal</option><option value="trimestre">Trimestral</option><option value="semestre">Semestral</option>
      <option value="ano">Anual</option><option value="personalizado">Personalizado</option></select></label>
    <label class="campo" id="cAno">Ano<select name="ano">${anos.map(y => `<option>${y}</option>`).join('')}</select></label>
    <label class="campo" id="cNum">Mês<select name="n"></select></label>
    <label class="campo" id="cIni" hidden>De<input type="date" name="ini"></label>
    <label class="campo" id="cFim" hidden>Até<input type="date" name="fim"></label>
    ${ehSup() ? `<label class="campo">Funcionário<select name="func"><option value="">Toda a equipe</option>${S.perfis.map(p => `<option value="${p.id}">${esc(p.nome)}${p.ativo ? '' : ' (inativo)'}</option>`).join('')}</select></label>` : ''}
    <button class="btn prim" type="submit">Gerar</button></div></form>
  <div id="rel"></div>`;
  const f = $('#fRel');
  const ajustarN = () => {
    const t = f.tipo.value; const ops = { mes: MESES.map((m, i) => [i + 1, m]), trimestre: [1, 2, 3, 4].map(i => [i, `${i}º trimestre`]), semestre: [[1, '1º semestre'], [2, '2º semestre']] }[t];
    $('#cNum').hidden = !ops; $('#cAno').hidden = t === 'personalizado'; $('#cIni').hidden = $('#cFim').hidden = t !== 'personalizado';
    if (ops) {
      $('#cNum').firstChild.textContent = { mes: 'Mês', trimestre: 'Trimestre', semestre: 'Semestre' }[t];
      const atual = { mes: ma, trimestre: Math.ceil(ma / 3), semestre: Math.ceil(ma / 6) }[t];
      f.n.innerHTML = ops.map(([v, r]) => `<option value="${v}" ${v === atual ? 'selected' : ''}>${r}</option>`).join('');
    }
  };
  f.tipo.addEventListener('change', ajustarN); ajustarN();
  f.ini.value = `${ya}-${pad(ma)}-01`; f.fim.value = hoje();
  f.addEventListener('submit', e => { e.preventDefault(); gerarRelatorio(f); });
  $('#btnImprimir').addEventListener('click', () => window.print());
  $('#btnCsv').addEventListener('click', () => baixarCsv());
  gerarRelatorio(f);
}

let ULTIMO = null;
async function gerarRelatorio(f) {
  const p = periodo(f.tipo.value, f.ano.value, f.n.value, f.ini.value, f.fim.value);
  if (!p.ini || !p.fim || p.ini > p.fim) return toast('Período inválido.', true);
  const func = f.func ? f.func.value || null : null;
  const nomeFunc = func ? (S.perfis.find(x => x.id === func)?.nome || '') : (ehSup() ? 'TODA A EQUIPE' : S.perfil.nome);
  const box = $('#rel'); box.innerHTML = '<p class="carregando">Calculando…</p>';
  const { data: R, error } = await sb.rpc('relatorio', { p_inicio: p.ini, p_fim: p.fim, p_func: func });
  if (error) { box.innerHTML = `<div class="aviso erro">${esc(msgErro(error))}</div>`; return; }
  ULTIMO = { R, p, nomeFunc };
  destruirGraficos();
  const T = R.totais;
  const k = (rot, val, det = '', cls = '') => `<div class="kpi ${cls}"><div class="rot">${rot}</div><div class="val">${val}</div>${det ? `<div class="det">${det}</div>` : ''}</div>`;
  const nDias = Math.round((dt(p.fim) - dt(p.ini)) / 864e5) + 1;
  const porDia = nDias <= 62;
  // série temporal completa (com zeros)
  let serie = [];
  if (porDia) {
    const m = Object.fromEntries(R.por_dia.map(d => [d.dia, d]));
    for (let d = p.ini; d <= p.fim; d = addDias(d, 1)) serie.push({ rot: d.slice(8) + '/' + d.slice(5, 7), ...(m[d] || { contatos: 0, boletos: 0, pagos: 0, valor: 0 }), chave: d });
  } else {
    const m = Object.fromEntries(R.por_mes.map(d => [d.mes, d]));
    let [y, mm] = p.ini.split('-').map(Number); const [y2, m2] = p.fim.split('-').map(Number);
    while (y < y2 || (y === y2 && mm <= m2)) { const key = `${y}-${pad(mm)}`; serie.push({ rot: `${MES_ABR[mm - 1]}/${String(y).slice(2)}`, ...(m[key] || { contatos: 0, boletos: 0, pagos: 0, revogados: 0, valor: 0 }), chave: key }); mm++; if (mm > 12) { mm = 1; y++; } }
  }
  ULTIMO.serie = serie; ULTIMO.porDia = porDia;
  const cats = CATEGORIAS.map(c => ({ c, q: (R.por_categoria.find(x => x.categoria === c) || {}).qtde || 0 }));
  const revs = R.por_situacao.filter(s => s.categoria === 'Revogado');
  const alertas = [];
  if (T.sem_situacao) alertas.push(`${T.sem_situacao} lançamento(s) sem situação no período.`);
  if (T.pago_sem_valor) alertas.push(`${T.pago_sem_valor} lançamento(s) "pago" sem valor informado.`);
  if (T.andamento) alertas.push(`${T.andamento} lançamento(s) ainda em andamento — os números podem mudar quando forem atualizados.`);

  box.innerHTML = `
  <div class="card"><h1 style="margin:0">Relatório de cobranças · ${esc(p.rotulo)}</h1>
    <p class="sub">${esc(nomeFunc)} · período de ${fmtData(p.ini)} a ${fmtData(p.fim)} · gerado em ${new Date().toLocaleString('pt-BR')}</p>
    ${alertas.map(a => `<div class="aviso atencao">${esc(a)}</div>`).join('')}</div>
  <div class="kpis">
    ${k('Contatos realizados', NUM.format(T.contatos), `${NUM.format(T.dias)} dia(s) trabalhado(s)`, 'destaque')}
    ${k('Boletos gerados', NUM.format(T.boletos))}
    ${k('Boletos pagos', NUM.format(T.pagos), `${NUM.format(T.parcelas)} parcela(s) paga(s)`)}
    ${k('Em andamento', NUM.format(T.andamento))}
    ${k('Revogados', NUM.format(T.revogados))}
    ${k('Valor arrecadado', BRL.format(T.valor), '', 'destaque')}
  </div>
  <div class="kpis">
    ${k('Conversão', PCT.format(div0(T.pagos, T.contatos)), 'pagos ÷ contatos')}
    ${k('Efetividade dos boletos', PCT.format(div0(T.pagos, T.boletos)), 'pagos ÷ boletos gerados')}
    ${k('Ticket médio', BRL.format(div0(T.valor, T.pagos)), 'valor ÷ pagos')}
    ${k('Contatos por dia', DEC.format(div0(T.contatos, T.dias)))}
    ${k('Ações', `${NUM.format(T.whatsapp + T.sms + T.ligacoes)}`, `WhatsApp ${NUM.format(T.whatsapp)} · SMS ${NUM.format(T.sms)} · Ligações ${NUM.format(T.ligacoes)}`)}
    ${k('Agendamentos', NUM.format(T.agendamentos))}
  </div>
  <div class="grade-2">
    <div class="card"><h3>Contatos, boletos e pagos ${porDia ? 'por dia' : 'por mês'}</h3>
      <div class="legenda"><span style="--cor:var(--s1)">Contatos</span><span style="--cor:var(--s2)">Boletos</span><span style="--cor:var(--s3)">Pagos</span></div>
      <div class="grafico"><canvas id="gQtd" role="img" aria-label="Contatos, boletos e pagos ao longo do período"></canvas></div></div>
    <div class="card"><h3>Valor arrecadado ${porDia ? 'por dia' : 'por mês'} (R$)</h3>
      <div class="grafico"><canvas id="gValor" role="img" aria-label="Valor arrecadado ao longo do período"></canvas></div></div>
    <div class="card"><h3>Resultado dos contatos</h3>
      <div class="grafico"><canvas id="gCat" role="img" aria-label="Contatos por categoria de resultado"></canvas></div>
      <table><tbody>${cats.map(x => `<tr class="${x.q ? '' : 'zero'}"><td>${tag(x.c)}</td><td class="num">${NUM.format(x.q)}</td><td class="num">${PCT.format(div0(x.q, T.contatos))}</td></tr>`).join('')}</tbody></table></div>
    <div class="card"><h3>Motivos de revogação</h3>
      <div class="grafico"><canvas id="gRev" role="img" aria-label="Quantidade por motivo de revogação"></canvas></div></div>
  </div>
  ${ehSup() && !func ? `<div class="card"><h3>Resultado por funcionário</h3><div class="tabela-wrap"><table><thead><tr><th>Funcionário</th><th class="num">Dias</th><th class="num">Contatos</th><th class="num">Boletos</th><th class="num">Pagos</th><th class="num">Em andam.</th><th class="num">Revog.</th><th class="num">Conversão</th><th class="num">Valor</th><th class="num">% do valor</th></tr></thead><tbody>
    ${R.por_funcionario.map(x => `<tr><td>${esc(x.nome)}</td><td class="num">${x.dias}</td><td class="num">${NUM.format(x.contatos)}</td><td class="num">${NUM.format(x.boletos)}</td><td class="num">${NUM.format(x.pagos)}</td><td class="num">${NUM.format(x.andamento)}</td><td class="num">${NUM.format(x.revogados)}</td><td class="num">${PCT.format(div0(x.pagos, x.contatos))}</td><td class="num">${BRL.format(x.valor)}</td><td class="num">${PCT.format(div0(x.valor, T.valor))}</td></tr>`).join('') || '<tr><td colspan="10" class="vazio">Sem lançamentos no período.</td></tr>'}
    <tr class="total"><td>Total</td><td class="num">${NUM.format(T.dias)}</td><td class="num">${NUM.format(T.contatos)}</td><td class="num">${NUM.format(T.boletos)}</td><td class="num">${NUM.format(T.pagos)}</td><td class="num">${NUM.format(T.andamento)}</td><td class="num">${NUM.format(T.revogados)}</td><td class="num">${PCT.format(div0(T.pagos, T.contatos))}</td><td class="num">${BRL.format(T.valor)}</td><td class="num">${T.valor ? '100,0%' : ''}</td></tr>
    </tbody></table></div></div>` : ''}
  <div class="grade-2">
    <div class="card"><h3>Resultado por setor</h3><div class="tabela-wrap"><table><thead><tr><th>Setor</th><th class="num">Contatos</th><th class="num">Pagos</th><th class="num">Conversão</th><th class="num">Valor</th></tr></thead><tbody>
      ${R.por_setor.map(x => `<tr><td>${esc(x.setor)}</td><td class="num">${NUM.format(x.contatos)}</td><td class="num">${NUM.format(x.pagos)}</td><td class="num">${PCT.format(div0(x.pagos, x.contatos))}</td><td class="num">${BRL.format(x.valor)}</td></tr>`).join('') || '<tr><td colspan="5" class="vazio">Sem lançamentos.</td></tr>'}
    </tbody></table></div></div>
    <div class="card"><h3>Resultado por situação</h3><div class="tabela-wrap"><table><thead><tr><th>Situação</th><th>Categoria</th><th class="num">Qtde</th><th class="num">%</th></tr></thead><tbody>
      ${R.por_situacao.map(x => `<tr class="${x.qtde ? '' : 'zero'}"><td>${esc(x.situacao)}</td><td>${tag(x.categoria)}</td><td class="num">${NUM.format(x.qtde)}</td><td class="num">${PCT.format(div0(x.qtde, T.contatos))}</td></tr>`).join('')}
      <tr class="${T.sem_situacao ? '' : 'zero'}"><td>(sem situação)</td><td>${tag('Sem situação')}</td><td class="num">${NUM.format(T.sem_situacao)}</td><td class="num">${PCT.format(div0(T.sem_situacao, T.contatos))}</td></tr>
    </tbody></table></div></div>
  </div>
  <div class="card"><details class="tab-dados" ${porDia ? '' : 'open'}><summary>Tabela ${porDia ? 'dia a dia' : 'mês a mês'} (dados dos gráficos)</summary>
    <div class="tabela-wrap"><table><thead><tr><th>${porDia ? 'Dia' : 'Mês'}</th><th class="num">Contatos</th><th class="num">Boletos</th><th class="num">Pagos</th><th class="num">Conversão</th><th class="num">Valor</th></tr></thead><tbody>
    ${serie.map(s => `<tr class="${s.contatos ? '' : 'zero'}"><td>${porDia ? `${s.rot} <span class="dica">${diaSemana(s.chave).slice(0, 3)}</span>` : s.rot}</td><td class="num">${NUM.format(s.contatos)}</td><td class="num">${NUM.format(s.boletos)}</td><td class="num">${NUM.format(s.pagos)}</td><td class="num">${s.contatos ? PCT.format(div0(s.pagos, s.contatos)) : ''}</td><td class="num">${BRL.format(s.valor)}</td></tr>`).join('')}
    <tr class="total"><td>Total</td><td class="num">${NUM.format(T.contatos)}</td><td class="num">${NUM.format(T.boletos)}</td><td class="num">${NUM.format(T.pagos)}</td><td class="num">${PCT.format(div0(T.pagos, T.contatos))}</td><td class="num">${BRL.format(T.valor)}</td></tr>
    </tbody></table></div></details></div>`;

  // ------- gráficos
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = css('--ink-2');
  const eixos = (moeda = false, horizontal = false) => {
    const valorAx = { beginAtZero: true, grid: { color: css('--grid') }, border: { display: false },
      ticks: { precision: 0, callback: v => (moeda ? 'R$ ' + NUM.format(v) : NUM.format(v)) } };
    const catAx = { grid: { display: false }, border: { color: css('--axis') }, ticks: { autoSkip: true, maxRotation: 0 } };
    return horizontal ? { x: valorAx, y: catAx } : { x: catAx, y: valorAx };
  };
  const tip = moeda => ({ callbacks: { label: c => `${c.dataset.label ? c.dataset.label + ': ' : ''}${moeda ? BRL.format(c.parsed.y ?? c.parsed.x) : NUM.format(c.parsed.y ?? c.parsed.x)}` } });
  const barra = { borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28, categoryPercentage: .8, barPercentage: .9 };
  const rots = serie.map(s => s.rot);
  S.charts.push(new Chart($('#gQtd'), { type: 'bar', data: { labels: rots, datasets: [
    { label: 'Contatos', data: serie.map(s => s.contatos), backgroundColor: css('--s1'), ...barra },
    { label: 'Boletos', data: serie.map(s => s.boletos), backgroundColor: css('--s2'), ...barra },
    { label: 'Pagos', data: serie.map(s => s.pagos), backgroundColor: css('--s3'), ...barra }] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: tip(false) }, scales: eixos() } }));
  S.charts.push(new Chart($('#gValor'), { type: 'bar', data: { labels: rots, datasets: [
    { label: 'Valor', data: serie.map(s => s.valor), backgroundColor: css('--s1'), ...barra }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: tip(true) }, scales: eixos(true) } }));
  const corCat = { 'Pago': css('--c-pago'), 'Em andamento': css('--c-and'), 'Revogado': css('--c-rev'), 'Outros': css('--c-out'), 'Sem situação': css('--c-sem') };
  S.charts.push(new Chart($('#gCat'), { type: 'bar', data: { labels: cats.map(x => x.c), datasets: [
    { label: 'Contatos', data: cats.map(x => x.q), backgroundColor: cats.map(x => corCat[x.c]), ...barra, maxBarThickness: 22 }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: tip(false) }, scales: eixos(false, true) } }));
  S.charts.push(new Chart($('#gRev'), { type: 'bar', data: { labels: revs.map(x => { const t = x.situacao.replace(/^REVOGADO\s*[–-]\s*/, '').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); }), datasets: [
    { label: 'Revogados', data: revs.map(x => x.qtde), backgroundColor: css('--c-rev'), ...barra, maxBarThickness: 22 }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: tip(false) }, scales: eixos(false, true) } }));
}

function destruirGraficos() { S.charts.forEach(c => c.destroy()); S.charts = []; }
window.addEventListener('beforeprint', () => S.charts.forEach(c => c.resize()));

function baixarCsv() {
  if (!ULTIMO) return;
  const { R, p, nomeFunc, serie, porDia } = ULTIMO; const T = R.totais;
  const n = v => String(v).replace('.', ',');
  const L = [];
  L.push(['Relatório de cobranças', p.rotulo], ['Funcionário', nomeFunc], ['Período', `${fmtData(p.ini)} a ${fmtData(p.fim)}`], []);
  L.push(['Indicador', 'Valor']);
  [['Contatos', T.contatos], ['Dias trabalhados', T.dias], ['WhatsApp', T.whatsapp], ['SMS', T.sms], ['Ligações', T.ligacoes], ['Agendamentos', T.agendamentos],
   ['Boletos gerados', T.boletos], ['Pagos', T.pagos], ['Em andamento', T.andamento], ['Revogados', T.revogados], ['Outros', T.outros], ['Sem situação', T.sem_situacao],
   ['Valor arrecadado', n(T.valor)], ['Parcelas pagas', T.parcelas], ['Conversão (%)', n((div0(T.pagos, T.contatos) * 100).toFixed(1))],
   ['Efetividade boletos (%)', n((div0(T.pagos, T.boletos) * 100).toFixed(1))], ['Ticket médio', n(div0(T.valor, T.pagos).toFixed(2))]].forEach(x => L.push(x));
  L.push([], [porDia ? 'Dia' : 'Mês', 'Contatos', 'Boletos', 'Pagos', 'Valor']);
  serie.forEach(s => L.push([porDia ? fmtData(s.chave) : s.chave, s.contatos, s.boletos, s.pagos, n(s.valor)]));
  L.push([], ['Setor', 'Contatos', 'Pagos', 'Valor']); R.por_setor.forEach(s => L.push([s.setor, s.contatos, s.pagos, n(s.valor)]));
  L.push([], ['Situação', 'Categoria', 'Qtde']); R.por_situacao.forEach(s => L.push([s.situacao, s.categoria, s.qtde])); L.push(['(sem situação)', 'Sem situação', T.sem_situacao]);
  if (ehSup()) { L.push([], ['Funcionário', 'Dias', 'Contatos', 'Boletos', 'Pagos', 'Em andamento', 'Revogados', 'Valor']); R.por_funcionario.forEach(f => L.push([f.nome, f.dias, f.contatos, f.boletos, f.pagos, f.andamento, f.revogados, n(f.valor)])); }
  const csv = '﻿' + L.map(r => r.map(c => { c = String(c ?? ''); return /[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c; }).join(';')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `relatorio_cobrancas_${p.ini}_a_${p.fim}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- ADMINISTRAÇÃO
async function telaAdmin() {
  if (!ehAdmin()) { location.hash = '#/lancar'; return; }
  app().innerHTML = `<div class="cab"><div><h1>Administração</h1><p class="sub">Liberação de acessos, padronização das listas e auditoria.</p></div></div>
  <div class="card"><h2>Usuários</h2><p class="dica">Novos cadastros aparecem aqui como "aguardando". Marque "Ativo" e escolha o papel. Para remover alguém, desmarque "Ativo".</p>
    <div class="tabela-wrap"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Ativo</th><th></th></tr></thead><tbody id="tbUsu"></tbody></table></div></div>
  <div class="card"><h2>Situações (resultado)</h2><p class="dica">A categoria define como a situação entra nos relatórios. Desative em vez de apagar, para manter o histórico.</p>
    <div class="tabela-wrap"><table><thead><tr><th>Situação</th><th>Categoria</th><th>Quando usar</th><th class="num">Ordem</th><th>Ativa</th><th></th></tr></thead><tbody id="tbSit"></tbody></table></div>
    <form class="linha" id="fNovaSit" style="margin-top:.8rem">
      <label class="campo">Nova situação<input name="codigo" maxlength="60" required placeholder="EX.: REVOGADO – FALECIDO"></label>
      <label class="campo">Categoria<select name="categoria">${CATEGORIAS.slice(0, 4).map(c => `<option>${c}</option>`).join('')}</select></label>
      <label class="campo" style="flex:1">Quando usar<input name="descricao" maxlength="200"></label>
      <button class="btn prim">Adicionar</button></form></div>
  <div class="card"><h2>Setores</h2><div class="tabela-wrap"><table><thead><tr><th>Setor</th><th class="num">Ordem</th><th>Ativo</th><th></th></tr></thead><tbody id="tbSet"></tbody></table></div>
    <form class="linha" id="fNovoSet" style="margin-top:.8rem"><label class="campo">Novo setor<input name="nome" maxlength="40" required></label><button class="btn prim">Adicionar</button></form></div>
  <div class="card"><h2>Auditoria (últimas 200 alterações)</h2><div class="tabela-wrap"><table><thead><tr><th>Quando</th><th>Usuário</th><th>Ação</th><th>Tabela</th><th>Registro</th><th>Campos alterados</th></tr></thead><tbody id="tbAud"><tr><td colspan="6" class="vazio">Carregando…</td></tr></tbody></table></div></div>`;
  await carregarTabelas();
  // usuários
  const tbU = $('#tbUsu');
  const usus = [...S.perfis].sort((a, b) => (a.ativo - b.ativo) || a.nome.localeCompare(b.nome));
  tbU.innerHTML = usus.map(u => `<tr data-id="${u.id}"><td>${esc(u.nome)}${u.ativo ? '' : ' <span class="tag Em-andamento">aguardando</span>'}</td><td>${esc(u.email || '')}</td>
    <td><select name="papel" ${u.id === S.user.id ? 'disabled' : ''}>${['funcionario', 'supervisor', 'admin'].map(p => `<option value="${p}" ${p === u.papel ? 'selected' : ''}>${({ funcionario: 'Funcionário', supervisor: 'Supervisão (só consulta)', admin: 'Administrador' })[p]}</option>`).join('')}</select></td>
    <td><input type="checkbox" name="ativo" ${u.ativo ? 'checked' : ''} ${u.id === S.user.id ? 'disabled' : ''} aria-label="Ativo"></td>
    <td>${u.id === S.user.id ? '<span class="dica">você</span>' : '<button class="btn peq">Salvar</button>'}</td></tr>`).join('');
  $$('tr[data-id] button', tbU).forEach(b => b.addEventListener('click', async () => {
    const tr = b.closest('tr');
    const { error } = await sb.from('perfis').update({ papel: tr.querySelector('[name=papel]').value, ativo: tr.querySelector('[name=ativo]').checked }).eq('id', tr.dataset.id);
    if (error) return toast(msgErro(error), true); toast('Usuário atualizado.'); telaAdmin();
  }));
  // situações
  const tbS = $('#tbSit');
  tbS.innerHTML = S.situacoes.map(s => `<tr data-cod="${esc(s.codigo)}"><td><strong>${esc(s.codigo)}</strong></td>
    <td><select name="categoria">${CATEGORIAS.slice(0, 4).map(c => `<option ${c === s.categoria ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
    <td><input name="descricao" value="${esc(s.descricao || '')}" maxlength="200"></td><td class="num"><input name="ordem" type="number" value="${s.ordem}" style="width:5rem"></td>
    <td><input type="checkbox" name="ativo" ${s.ativo ? 'checked' : ''} aria-label="Ativa"></td><td><button class="btn peq">Salvar</button></td></tr>`).join('');
  $$('tr[data-cod] button', tbS).forEach(b => b.addEventListener('click', async () => {
    const tr = b.closest('tr');
    const { error } = await sb.from('situacoes').update({ categoria: tr.querySelector('[name=categoria]').value, descricao: tr.querySelector('[name=descricao]').value.trim() || null,
      ordem: Number(tr.querySelector('[name=ordem]').value) || 100, ativo: tr.querySelector('[name=ativo]').checked }).eq('codigo', tr.dataset.cod);
    if (error) return toast(msgErro(error), true); toast('Situação atualizada.'); carregarTabelas();
  }));
  $('#fNovaSit').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    const { error } = await sb.from('situacoes').insert({ codigo: f.codigo.value.trim().toUpperCase().replace(/\s+-\s+/g, ' – '), categoria: f.categoria.value, descricao: f.descricao.value.trim() || null, ordem: 90 });
    if (error) return toast(msgErro(error), true); toast('Situação criada.'); telaAdmin();
  });
  // setores
  const tbT = $('#tbSet');
  tbT.innerHTML = S.setores.map(s => `<tr data-nome="${esc(s.nome)}"><td>${esc(s.nome)}</td><td class="num"><input name="ordem" type="number" value="${s.ordem}" style="width:5rem"></td>
    <td><input type="checkbox" name="ativo" ${s.ativo ? 'checked' : ''} aria-label="Ativo"></td><td><button class="btn peq">Salvar</button></td></tr>`).join('');
  $$('tr[data-nome] button', tbT).forEach(b => b.addEventListener('click', async () => {
    const tr = b.closest('tr');
    const { error } = await sb.from('setores').update({ ordem: Number(tr.querySelector('[name=ordem]').value) || 100, ativo: tr.querySelector('[name=ativo]').checked }).eq('nome', tr.dataset.nome);
    if (error) return toast(msgErro(error), true); toast('Setor atualizado.'); carregarTabelas();
  }));
  $('#fNovoSet').addEventListener('submit', async e => {
    e.preventDefault(); const { error } = await sb.from('setores').insert({ nome: e.target.nome.value.trim(), ordem: 50 });
    if (error) return toast(msgErro(error), true); toast('Setor criado.'); telaAdmin();
  });
  // auditoria
  const { data: aud, error } = await sb.from('auditoria').select('*').order('quando', { ascending: false }).limit(200);
  const tbA = $('#tbAud');
  if (error) { tbA.innerHTML = `<tr><td colspan="6" class="vazio">${esc(msgErro(error))}</td></tr>`; return; }
  const nomes = Object.fromEntries(S.perfis.map(p => [p.id, p.nome]));
  const ign = new Set(['atualizado_em', 'atualizado_por', 'criado_em']);
  tbA.innerHTML = (aud || []).map(a => {
    let campos = '';
    if (a.acao === 'UPDATE' && a.antes && a.depois) campos = Object.keys(a.depois).filter(k => !ign.has(k) && JSON.stringify(a.antes[k]) !== JSON.stringify(a.depois[k])).join(', ');
    const reg = a.tabela === 'lancamentos' ? `Id parc. ${(a.depois || a.antes || {}).id_parcelamento || ''}` : (a.registro || '');
    return `<tr><td>${new Date(a.quando).toLocaleString('pt-BR')}</td><td>${esc(nomes[a.usuario] || (a.usuario ? '—' : 'sistema'))}</td>
      <td>${({ INSERT: 'Inclusão', UPDATE: 'Alteração', DELETE: 'Exclusão' })[a.acao] || esc(a.acao)}</td><td>${esc(a.tabela)}</td><td>${esc(reg)}</td><td class="dica">${esc(campos)}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="vazio">Nenhum registro.</td></tr>';
}

// ---------------------------------------------------------------- MINHA CONTA
async function telaConta() {
  const { data: fat } = await sb.auth.mfa.listFactors();
  const fator = (fat?.totp || []).find(f => f.status === 'verified');
  app().innerHTML = `<div class="cab"><h1>Minha conta</h1></div>
  <div class="grade-2">
    <form class="card form-col" id="fNome"><h2>Dados</h2>
      <label class="campo">Nome exibido nos relatórios<input name="nome" value="${esc(S.perfil.nome)}" minlength="2" maxlength="80" required></label>
      <p class="dica">E-mail: ${esc(S.user.email)}</p><button class="btn prim">Salvar nome</button></form>
    <form class="card form-col" id="fSen"><h2>Alterar senha</h2>
      <label class="campo">Nova senha (mínimo 10 caracteres)<input type="password" name="senha" minlength="10" required autocomplete="new-password"></label>
      <label class="campo">Repita<input type="password" name="senha2" minlength="10" required autocomplete="new-password"></label>
      <button class="btn prim">Alterar senha</button></form>
    <div class="card form-col"><h2>Verificação em duas etapas</h2>
      ${fator ? `<div class="aviso ok">Ativada. A cada login será pedido o código do aplicativo autenticador.</div><button class="btn perigo" id="mfaOff">Desativar</button>`
        : `<p>Recomendado: além da senha, o sistema pedirá um código do celular (Google Authenticator, Microsoft Authenticator etc.).</p><button class="btn prim" id="mfaOn">Ativar</button><div id="mfaBox"></div>`}
    </div>
  </div>`;
  $('#fNome').addEventListener('submit', async e => {
    e.preventDefault(); const nome = e.target.nome.value.trim();
    const { error } = await sb.from('perfis').update({ nome }).eq('id', S.user.id);
    if (error) return toast(msgErro(error), true); S.perfil.nome = nome; toast('Nome atualizado.');
    $('#nomeUsuario').textContent = `${nome} · ${({ funcionario: 'Funcionário', supervisor: 'Supervisão', admin: 'Administrador' })[S.perfil.papel]}`;
  });
  $('#fSen').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target; if (f.senha.value !== f.senha2.value) return toast('As senhas não conferem.', true);
    const { error } = await sb.auth.updateUser({ password: f.senha.value });
    if (error) return toast(msgErro(error), true); f.reset(); toast('Senha alterada.');
  });
  if (fator) $('#mfaOff').addEventListener('click', async () => {
    if (!confirm('Desativar a verificação em duas etapas?')) return;
    const { error } = await sb.auth.mfa.unenroll({ factorId: fator.id });
    if (error) return toast(msgErro(error), true); toast('Desativada.'); telaConta();
  });
  else $('#mfaOn').addEventListener('click', async () => {
    // remove tentativas antigas não verificadas
    for (const f of (fat?.all || []).filter(x => x.status !== 'verified')) await sb.auth.mfa.unenroll({ factorId: f.id });
    const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Celular ' + Date.now() });
    if (error) return toast(msgErro(error), true);
    $('#mfaOn').hidden = true;
    $('#mfaBox').innerHTML = `<p>1. No aplicativo autenticador, leia o QR code (ou digite a chave):</p>
      <img class="qr" alt="QR code para o aplicativo autenticador" src="${esc(data.totp.qr_code)}"><p><code class="seg">${esc(data.totp.secret)}</code></p>
      <form class="form-col" id="fMfaAt"><label class="campo">2. Digite o código de 6 dígitos<input name="codigo" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code"></label><button class="btn prim">Confirmar e ativar</button></form>`;
    $('#fMfaAt').addEventListener('submit', async e => {
      e.preventDefault();
      const { error: er } = await sb.auth.mfa.challengeAndVerify({ factorId: data.id, code: e.target.codigo.value.trim() });
      if (er) return toast(msgErro(er), true); toast('Verificação em duas etapas ativada.'); telaConta();
    });
  });
}

iniciar();
})();
