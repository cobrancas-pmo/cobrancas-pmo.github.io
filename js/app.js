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
// "Revogado" é o nome interno; para o usuário a categoria se chama "Sem sucesso"
const CAT_LABEL = { 'Revogado': 'Sem sucesso' };
const catNome = c => CAT_LABEL[c] || c;
const OPC = {
  fonte: ['Cadastro', 'Localize', 'Assertiva', 'Informado pelo contribuinte'],
  whatsapp: ['Enviado', 'Respondido', 'Sem WhatsApp'],
  sms: ['Enviado', 'Respondido'],
  ligacao: ['Atendida', 'Não atendida', 'Número errado'],
  meio_acordo: ['WhatsApp', 'SMS', 'Ligação', 'Atendimento presencial', 'Contribuinte procurou']
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
const tag = c => `<span class="tag ${catClass(c)}">${esc(catNome(c || 'Sem situação'))}</span>`;
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
    [/lancamentos_meio_acordo_check/i, 'Meio que gerou o acordo inválido.'],
    [/lancamentos_situacao_fkey/i, 'Esta situação já foi usada em lançamentos e não pode ser excluída. Desative-a.'],
    [/lancamentos_vencimento_apos_emissao/i, 'O vencimento não pode ser anterior à emissão do boleto.'],
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
// "Meio que gerou o acordo" só faz sentido quando houve pagamento ou boleto/acordo em aberto
const aceitaMeio = cod => catDe(cod) === 'Pago' || sitConfere(cod);
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
  atualizarAvisoGlobal();
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

// ---------------------------------------------------------------- tema claro/escuro
const TEMAS = [['auto', '◐', 'automático (segue o computador)'], ['light', '☀', 'claro'], ['dark', '☾', 'escuro']];
function temaAtual() { const t = document.documentElement.getAttribute('data-theme'); return t === 'light' || t === 'dark' ? t : 'auto'; }
function mostrarTema() {
  const [, icone, nome] = TEMAS.find(x => x[0] === temaAtual());
  const b = $('#btnTema'); b.textContent = icone; b.title = `Tema: ${nome} — clique para alternar`;
}
$('#btnTema').addEventListener('click', () => {
  const i = TEMAS.findIndex(x => x[0] === temaAtual()); const prox = TEMAS[(i + 1) % TEMAS.length][0];
  if (prox === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', prox);
  try { if (prox === 'auto') localStorage.removeItem('tema'); else localStorage.setItem('tema', prox); } catch (e) {}
  mostrarTema(); toast(`Tema ${TEMAS.find(x => x[0] === prox)[2]}.`);
  if ($('#fRel')) gerarRelatorio($('#fRel')); else if (S.charts.length) rotear();   // redesenha os gráficos com as cores do tema
});
mostrarTema();

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
  const telas = { lancar: telaLancar, pendentes: telaPendentes, relatorios: telaRelatorios, cancelamentos: telaCancelamentos, admin: telaAdmin, conta: telaConta };
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
    return itens.length ? `<optgroup label="${esc(catNome(cat))}">${itens.map(s => `<option value="${esc(s.codigo)}" ${s.codigo === sel ? 'selected' : ''}>${esc(s.codigo)}</option>`).join('')}</optgroup>` : '';
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
    </div></fieldset>
    <fieldset><legend>Boletos</legend><div class="grade">
      <label class="campo">Boleto emitido em<input type="date" name="boleto_emitido"></label>
      <label class="campo">Data de vencimento<input type="date" name="boleto_vencimento"></label>
      <label class="campo">Nº de parcelas<input type="number" name="parcelas" min="1" max="240" step="1"></label>
      <label class="campo">Valor do boleto (R$)<input name="valor_boleto" inputmode="decimal" placeholder="0,00"></label>
    </div></fieldset>
    <fieldset><legend>Resultado</legend><div class="grade">
      <label class="campo largo">Situação<select name="situacao">${optSituacoes()}</select><span class="dica" id="descSit"></span></label>
      <label class="campo">Valor pago (R$)<input name="valor_pago" inputmode="decimal" placeholder="0,00"></label>
      <label class="campo">Data do pagamento<input type="date" name="data_pagamento"></label>
      <label class="campo" id="cMeio">Meio que gerou o acordo<select name="meio_acordo" disabled>${optList(OPC.meio_acordo)}</select><span class="dica">Para pagos e boletos em aberto</span></label>
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
  const ajustarMeio = () => { const ok = aceitaMeio(f.situacao.value); f.meio_acordo.disabled = !ok; if (!ok) f.meio_acordo.value = ''; };
  f._ajustarMeio = ajustarMeio;
  const limpar = () => { f.reset(); f._wppConferido = null; ajustarMeio(); f.registro.value = ''; $('#tituloForm').textContent = 'Novo lançamento'; $('#btnSalvar').textContent = 'Salvar lançamento'; $('#avisoDup').innerHTML = ''; $('#descSit').textContent = ''; };
  $('#btnLimpar').addEventListener('click', limpar);
  f.situacao.addEventListener('change', () => {
    $('#descSit').textContent = S.situacoes.find(s => s.codigo === f.situacao.value)?.descricao || '';
    ajustarMeio();
    if (catDe(f.situacao.value) === 'Pago') {
      if (!f.data_pagamento.value) f.data_pagamento.value = hoje();
      if (!f.valor_pago.value && f.valor_boleto.value) f.valor_pago.value = f.valor_boleto.value;   // sugere o valor do boleto
    } else f.data_pagamento.value = '';
  });
  f.id_parcelamento.addEventListener('blur', () => verificarDuplicado(f));
  for (const nm of ['valor_pago', 'valor_boleto']) f[nm].addEventListener('blur', () => { const v = parseValor(f[nm].value); if (v != null && !Number.isNaN(v)) f[nm].value = fmtValorInput(v); });

  f.addEventListener('submit', async e => {
    e.preventDefault();
    const o = {
      id_parcelamento: f.id_parcelamento.value.trim(), setor: f.setor.value || null, origem: f.origem.value.trim() || null,
      fonte_contato: f.fonte_contato.value || null, whatsapp: f.whatsapp.value || null, sms: f.sms.value || null,
      ligacao: f.ligacao.value || null, agendamento: f.agendamento.value || null, boleto_emitido: f.boleto_emitido.value || null, boleto_vencimento: f.boleto_vencimento.value || null,
      parcelas: f.parcelas.value ? Number(f.parcelas.value) : null, valor_boleto: parseValor(f.valor_boleto.value), situacao: f.situacao.value || null,
      valor_pago: parseValor(f.valor_pago.value), data_pagamento: f.data_pagamento.value || null, observacoes: f.observacoes.value.trim() || null,
      meio_acordo: f.meio_acordo.value || null
    };
    if (!aceitaMeio(o.situacao)) o.meio_acordo = null;
    if (!RE_ID.test(o.id_parcelamento)) { f.id_parcelamento.setAttribute('aria-invalid', 'true'); f.id_parcelamento.focus(); return toast('Informe o Id do parcelamento (só números/letras, sem espaços).', true); }
    f.id_parcelamento.removeAttribute('aria-invalid');
    if (o.origem && !RE_ID.test(o.origem)) return toast('Origem/inscrição: use só números/letras, sem espaços.', true);
    if (Number.isNaN(o.valor_pago)) return toast('Valor pago inválido. Exemplo: 388,15', true);
    if (Number.isNaN(o.valor_boleto)) return toast('Valor do boleto inválido. Exemplo: 388,15', true);
    if (o.valor_boleto != null && !o.boleto_emitido && !confirm('Há valor do boleto, mas sem a data de emissão. Salvar mesmo assim?')) return;
    if (o.boleto_vencimento && o.boleto_emitido && o.boleto_vencimento < o.boleto_emitido) return toast('O vencimento não pode ser anterior à emissão do boleto.', true);
    if (o.boleto_emitido && !o.boleto_vencimento && sitConfere(o.situacao) && !confirm('Boleto sem data de vencimento: o sistema não poderá avisar quando conferir o pagamento. Salvar mesmo assim?')) return;
    if (o.parcelas != null && !(Number.isInteger(o.parcelas) && o.parcelas >= 1 && o.parcelas <= 240)) return toast('Nº de parcelas deve ser um número inteiro de 1 a 240.', true);
    const cat = catDe(o.situacao);
    if (cat === 'Pago') {
      if (!o.data_pagamento) o.data_pagamento = hoje();
      if (o.data_pagamento > hoje()) return toast('A data do pagamento não pode ser futura.', true);
      if (o.boleto_emitido && o.data_pagamento < o.boleto_emitido && !confirm('A data do pagamento é anterior à emissão do boleto. Salvar mesmo assim?')) return;
    } else o.data_pagamento = null;
    if (cat === 'Pago' && o.valor_pago == null && !confirm('Situação "pago" sem valor informado. Salvar mesmo assim?')) return;
    if (cat !== 'Pago' && o.valor_pago != null && !confirm('Há valor pago, mas a situação não é de pagamento. Salvar mesmo assim?')) return;
    // o primeiro contato é sempre via WhatsApp: ajuda a manter o funil correto
    if (!o.whatsapp && !confirm('O primeiro contato é sempre via WhatsApp, mas o campo WhatsApp está vazio.\n\nOK = salvar assim mesmo\nCancelar = voltar e informar (Enviado, Respondido ou Sem WhatsApp)')) { f.whatsapp.focus(); return; }
    if (o.whatsapp === 'Enviado' && (cat === 'Pago' || o.boleto_emitido) && f._wppConferido !== (f.registro.value || 'novo')) {
      f._wppConferido = f.registro.value || 'novo';
      if (confirm('Houve acordo/pagamento, mas o WhatsApp está só como "Enviado".\nO contribuinte respondeu pelo WhatsApp?\n\nOK = sim, marcar como "Respondido"\nCancelar = não, manter "Enviado"')) { o.whatsapp = 'Respondido'; f.whatsapp.value = 'Respondido'; }
    }
    if (/\b\d{2}\s?9?\d{4}-?\d{4}\b|\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(o.observacoes || '') &&
        !confirm('As observações parecem conter telefone ou CPF. Dados pessoais não devem ser registrados aqui. Salvar mesmo assim?')) return;
    const b = $('#btnSalvar'); b.disabled = true;
    const id = f.registro.value;
    const r = id ? await sb.from('lancamentos').update(o).eq('id', id)
                 : await sb.from('lancamentos').insert({ ...o, data_contato: dia });
    b.disabled = false;
    if (r.error) return toast(msgErro(r.error), true);
    toast(id ? 'Lançamento atualizado.' : 'Lançamento salvo.'); atualizarAvisoGlobal();
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
  for (const k of ['id_parcelamento', 'origem', 'agendamento', 'boleto_emitido', 'boleto_vencimento', 'parcelas', 'observacoes']) f[k].value = l[k] ?? '';
  for (const k of ['setor', 'fonte_contato', 'whatsapp', 'sms', 'ligacao', 'meio_acordo']) {
    if (l[k] && ![...f[k].options].some(o => o.value === l[k])) f[k].insertAdjacentHTML('beforeend', `<option>${esc(l[k])}</option>`);
    f[k].value = l[k] ?? '';
  }
  f.situacao.innerHTML = optSituacoes(l.situacao); f.situacao.value = l.situacao ?? '';
  $('#descSit').textContent = S.situacoes.find(s => s.codigo === l.situacao)?.descricao || '';
  f.valor_pago.value = fmtValorInput(l.valor_pago);
  f.valor_boleto.value = fmtValorInput(l.valor_boleto);
  f.data_pagamento.value = l.data_pagamento || '';
  f.meio_acordo.disabled = !aceitaMeio(l.situacao);
  f._wppConferido = null;
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
    ['Em andamento', cont('Em andamento')], ['Sem sucesso', cont('Revogado')], ['Sem situação', cont('Sem situação')], ['Valor pago (contatos do dia)', BRL.format(valor)]
  ].map(([r, v]) => `<div class="kpi"><div class="rot">${r}</div><div class="val">${typeof v === 'number' ? NUM.format(v) : v}</div></div>`).join('');
  $('#qtdDia').textContent = `${rows.length} contato(s)`;
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="9" class="vazio">Nenhum contato lançado neste dia.</td></tr>'; return; }
  tb.innerHTML = rows.map((r, i) => {
    const acoes = [r.whatsapp && `WhatsApp: ${r.whatsapp}`, r.sms && `SMS: ${r.sms}`, r.ligacao && `Ligação: ${r.ligacao}`, r.agendamento && `Agend.: ${fmtData(r.agendamento)}`].filter(Boolean);
    return `<tr><td>${i + 1}</td><td><strong>${esc(r.id_parcelamento)}</strong>${r.origem ? `<div class="dica">Origem ${esc(r.origem)}</div>` : ''}</td>
      <td>${esc(r.setor || '')}</td><td class="dica">${acoes.map(esc).join('<br>')}${tagAgend(r)}</td>
      <td>${r.boleto_emitido ? fmtData(r.boleto_emitido) + (r.parcelas ? `<div class="dica">${r.parcelas} parc.</div>` : '') : ''}${r.valor_boleto != null ? `<div class="dica">${BRL.format(r.valor_boleto)}</div>` : ''}${r.boleto_vencimento ? `<div class="dica">venc. ${fmtData(r.boleto_vencimento)}</div>` : ''}${tagVenc(r)}</td>
      <td>${tag(catDe(r.situacao))}<div class="dica">${esc(r.situacao || '')}</div>${tagCanc(r)}</td>
      <td class="num">${r.valor_pago != null ? BRL.format(r.valor_pago) : ''}${r.data_pagamento ? `<div class="dica">pago em ${fmtData(r.data_pagamento)}</div>` : ''}</td>
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
async function telaPendentes(params = {}) {
  app().innerHTML = `<div class="cab"><div><h1>Pendentes</h1><p class="sub">Seus lançamentos ainda "em andamento" ou sem situação. Boletos vencidos e agendamentos cuja data já passou aparecem primeiro: confira e atualize a situação.</p></div>
    <div class="acoes"><label class="campo">Mostrar<select id="filtroPend">
      <option value="todos">Todos os pendentes</option><option value="venc">Só boletos vencidos (conferir)</option><option value="agend">Só agendamentos vencidos (conferir comparecimento)</option>
      <option value="and">Só "Em andamento"</option><option value="sem">Só "Sem situação"</option></select></label></div></div>
    <div id="quadroEquipe"></div>
    <div class="card"><div class="tabela-wrap"><table><thead><tr><th>Data do contato</th><th class="num">Dias</th><th>Id parc.</th><th>Setor</th><th>Situação</th><th>Agendamento</th><th>Boleto</th><th>Observações</th><th></th></tr></thead>
    <tbody id="tbPend"><tr><td colspan="9" class="vazio">Carregando…</td></tr></tbody></table></div>
    <p class="dica">Boletos: o aviso aparece ${PRAZO_UTEIS} dias úteis após o vencimento (prazo de compensação bancária; feriados não são considerados). Agendamentos: o aviso aparece no dia seguinte à data agendada, enquanto o caso continuar "em andamento". Se a pessoa não compareceu, use "SEM SUCESSO – NÃO COMPARECEU" (ou reagende, mudando a data).</p></div>`;
  if (params.filtro && [...$('#filtroPend').options].some(o => o.value === params.filtro)) $('#filtroPend').value = params.filtro;
  const codsAnd = S.situacoes.filter(s => s.categoria === 'Em andamento').map(s => `"${s.codigo.replace(/"/g, '')}"`);
  const { data, error } = await sb.from('lancamentos').select('*').eq('funcionario_id', S.user.id)
    .or(`situacao.is.null${codsAnd.length ? `,situacao.in.(${codsAnd.join(',')})` : ''}`)
    .order('data_contato').order('id').limit(1000);
  const tb = $('#tbPend');
  if (error) { tb.innerHTML = `<tr><td colspan="9" class="vazio">${esc(msgErro(error))}</td></tr>`; return; }
  const conferir = r => statusVenc(r) === 'conferir' || statusAgend(r) === 'conferir';
  const pri = r => (conferir(r) ? 0 : (statusVenc(r) === 'compensacao' || statusAgend(r) === 'hoje') ? 1 : 2);
  const dataRef = r => [statusVenc(r) === 'conferir' ? r.boleto_vencimento : null, statusAgend(r) === 'conferir' ? r.agendamento : null].filter(Boolean).sort()[0] || '9999';
  const todas = (data || []).slice().sort((a, b) => pri(a) - pri(b) || (pri(a) === 0 ? dataRef(a).localeCompare(dataRef(b)) : 0));
  const desenhar = () => {
    const filtro = $('#filtroPend').value;
    const rows = todas.filter(r => filtro === 'todos' || (filtro === 'venc' ? statusVenc(r) === 'conferir' : filtro === 'agend' ? statusAgend(r) === 'conferir' : filtro === 'sem' ? !r.situacao : !!r.situacao));
    if (!rows.length) { tb.innerHTML = `<tr><td colspan="9" class="vazio">${filtro === 'venc' ? 'Nenhum boleto vencido para conferir. 👍' : filtro === 'agend' ? 'Nenhum agendamento vencido para conferir. 👍' : 'Nenhuma pendência. 👍'}</td></tr>`; return; }
    tb.innerHTML = rows.map(r => `<tr class="${conferir(r) ? 'linha-alerta' : ''}"><td>${fmtData(r.data_contato)}</td><td class="num">${diasDesde(r.data_contato)}</td>
      <td><strong>${esc(r.id_parcelamento)}</strong></td><td>${esc(r.setor || '')}</td>
      <td>${tag(catDe(r.situacao))}<div class="dica">${esc(r.situacao || '')}</div></td><td>${fmtData(r.agendamento)}${tagAgend(r)}</td>
      <td>${fmtData(r.boleto_emitido)}${r.boleto_vencimento ? `<div class="dica">venc. ${fmtData(r.boleto_vencimento)}</div>` : ''}${tagVenc(r)}</td>
      <td class="obs">${esc(r.observacoes || '')}</td><td><a class="btn peq ${conferir(r) ? 'prim' : ''}" href="#/lancar?data=${r.data_contato}&editar=${r.id}">${conferir(r) ? 'Conferir' : 'Atualizar'}</a></td></tr>`).join('');
  };
  $('#filtroPend').addEventListener('change', desenhar); desenhar();

  // quadro da equipe (supervisão)
  if (ehSup()) {
    const [bol, agd] = await Promise.all([buscarBoletosAConferir(true), buscarAgendamentosAConferir(true)]);
    const nomes = Object.fromEntries(S.perfis.map(p => [p.id, p.nome]));
    const quadro = (titulo, lista, campo, rotQtd, rotData, rotLista, vazio) => {
      const porFunc = {};
      for (const r of lista) { const g = (porFunc[r.funcionario_id] ||= { qtd: 0, maisAntigo: r[campo] }); g.qtd++; if (r[campo] < g.maisAntigo) g.maisAntigo = r[campo]; }
      const linhas = Object.entries(porFunc).sort((a, b) => b[1].qtd - a[1].qtd);
      return `<div class="card"><div class="cab"><h2>${titulo}</h2><span class="dica">${lista.length} no total</span></div>
      ${linhas.length ? `<div class="tabela-wrap"><table><thead><tr><th>Funcionário</th><th class="num">${rotQtd}</th><th>${rotData} mais antigo</th><th class="num">Dias desde então</th></tr></thead><tbody>
      ${linhas.map(([id, g]) => `<tr class="${diasDesde(g.maisAntigo) > 10 ? 'linha-alerta' : ''}"><td>${esc(nomes[id] || '—')}</td><td class="num">${g.qtd}</td><td>${fmtData(g.maisAntigo)}</td><td class="num">${diasDesde(g.maisAntigo)}</td></tr>`).join('')}
      </tbody></table></div>
      <details class="tab-dados"><summary>${rotLista}</summary><div class="tabela-wrap"><table><thead><tr><th>Funcionário</th><th>Id parc.</th><th>Situação</th><th>${rotData}</th><th class="num">Dias</th></tr></thead><tbody>
      ${lista.map(r => `<tr><td>${esc(nomes[r.funcionario_id] || '—')}</td><td><strong>${esc(r.id_parcelamento)}</strong></td><td class="dica">${esc(r.situacao || '(sem situação)')}</td><td>${fmtData(r[campo])}</td><td class="num">${diasDesde(r[campo])}</td></tr>`).join('')}
      </tbody></table></div></details>` : `<p class="vazio">${vazio}</p>`}</div>`;
    };
    $('#quadroEquipe').innerHTML =
      quadro('Boletos vencidos sem conferência — equipe', bol, 'boleto_vencimento', 'Boletos a conferir', 'Vencimento', 'Ver todos os boletos vencidos da equipe', 'Nenhum boleto vencido aguardando conferência na equipe. 👍') +
      quadro('Agendamentos vencidos sem atualização — equipe', agd, 'agendamento', 'Agendamentos a conferir', 'Agendamento', 'Ver todos os agendamentos vencidos da equipe', 'Nenhum agendamento vencido aguardando atualização na equipe. 👍');
  }
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
  const args = { p_inicio: p.ini, p_fim: p.fim, p_func: func };
  const [{ data: R, error }, { data: E, error: errE }] = await Promise.all([sb.rpc('relatorio', args), sb.rpc('relatorio_eficacia', args)]);
  if (error) { box.innerHTML = `<div class="aviso erro">${esc(msgErro(error))}</div>`; return; }
  ULTIMO = { R, p, nomeFunc, E: errE ? null : E };
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
    <p class="dica">Contatos, ações e resultados contam pela <strong>data do contato</strong>; pagamentos e valor arrecadado, pela <strong>data do pagamento</strong>.</p>
    ${alertas.map(a => `<div class="aviso atencao">${esc(a)}</div>`).join('')}</div>
  <div class="kpis">
    ${k('Contatos realizados', NUM.format(T.contatos), `${NUM.format(T.dias)} dia(s) trabalhado(s)`, 'destaque')}
    ${k('Boletos gerados', NUM.format(T.boletos), T.valor_boletos ? `${BRL.format(T.valor_boletos)} em boletos` : '')}
    ${k('Pagamentos no período', NUM.format(T.pagos), `pela data do pagamento · ${NUM.format(T.parcelas)} parcela(s)`)}
    ${k('Em andamento', NUM.format(T.andamento))}
    ${k('Sem sucesso', NUM.format(T.revogados))}
    ${k('Valor arrecadado', BRL.format(T.valor), 'pela data do pagamento', 'destaque')}
  </div>
  <div class="kpis">
    ${k('Conversão dos contatos', PCT.format(div0(T.pagos_contatos, T.contatos)), `${NUM.format(T.pagos_contatos || 0)} contato(s) do período já pagos`)}
    ${k('Efetividade dos boletos', PCT.format(div0(T.pagos_contatos, T.boletos)), 'boletos do período já pagos')}
    ${k('Ticket médio', BRL.format(div0(T.valor, T.pagos)), 'valor ÷ pagamentos')}
    ${k('Contatos por dia', DEC.format(div0(T.contatos, T.dias)))}
    ${k('Ações', `${NUM.format(T.whatsapp + T.sms + T.ligacoes)}`, `WhatsApp ${NUM.format(T.whatsapp)} · SMS ${NUM.format(T.sms)} · Ligações ${NUM.format(T.ligacoes)}`)}
    ${k('Agendamentos', NUM.format(T.agendamentos))}
  </div>
  <div class="kpis">
    ${k('Cancelamento: aguardando envio', NUM.format(T.canc_aguardando || 0), 'na fila do próximo relatório de quinta')}
    ${k('Encaminhados à Recuperação de Ativos', NUM.format(T.canc_enviados || 0))}
    ${k('Acordos revogados pelo setor', NUM.format(T.canc_cancelados || 0))}
    ${k('Não revogados pelo setor', NUM.format(T.canc_devolvidos || 0))}
  </div>
  <div class="grade-2">
    <div class="card"><h3>Contatos, boletos e pagos ${porDia ? 'por dia' : 'por mês'}</h3>
      <div class="legenda"><span style="--cor:var(--s1)">Contatos</span><span style="--cor:var(--s2)">Boletos</span><span style="--cor:var(--s3)">Pagamentos (data do pagamento)</span></div>
      <div class="grafico"><canvas id="gQtd" role="img" aria-label="Contatos, boletos e pagos ao longo do período"></canvas></div></div>
    <div class="card"><h3>Valor arrecadado ${porDia ? 'por dia' : 'por mês'} (R$)</h3>
      <div class="grafico"><canvas id="gValor" role="img" aria-label="Valor arrecadado ao longo do período"></canvas></div></div>
    <div class="card"><h3>Resultado dos contatos</h3>
      <div class="grafico"><canvas id="gCat" role="img" aria-label="Contatos por categoria de resultado"></canvas></div>
      <table><tbody>${cats.map(x => `<tr class="${x.q ? '' : 'zero'}"><td>${tag(x.c)}</td><td class="num">${NUM.format(x.q)}</td><td class="num">${PCT.format(div0(x.q, T.contatos))}</td></tr>`).join('')}</tbody></table></div>
    <div class="card"><h3>Motivos sem sucesso</h3>
      <div class="grafico"><canvas id="gRev" role="img" aria-label="Quantidade por motivo sem sucesso"></canvas></div></div>
  </div>
  ${ehSup() && !func ? `<div class="card"><h3>Resultado por funcionário</h3><div class="tabela-wrap"><table><thead><tr><th>Funcionário</th><th class="num">Dias</th><th class="num">Contatos</th><th class="num">Boletos</th><th class="num">Pagos</th><th class="num">Em andam.</th><th class="num">Sem suc.</th><th class="num">Conversão</th><th class="num">Valor</th><th class="num">% do valor</th></tr></thead><tbody>
    ${R.por_funcionario.map(x => `<tr><td>${esc(x.nome)}</td><td class="num">${x.dias}</td><td class="num">${NUM.format(x.contatos)}</td><td class="num">${NUM.format(x.boletos)}</td><td class="num">${NUM.format(x.pagos)}</td><td class="num">${NUM.format(x.andamento)}</td><td class="num">${NUM.format(x.revogados)}</td><td class="num">${PCT.format(div0(x.pagos_contatos, x.contatos))}</td><td class="num">${BRL.format(x.valor)}</td><td class="num">${PCT.format(div0(x.valor, T.valor))}</td></tr>`).join('') || '<tr><td colspan="10" class="vazio">Sem lançamentos no período.</td></tr>'}
    <tr class="total"><td>Total</td><td class="num">${NUM.format(T.dias)}</td><td class="num">${NUM.format(T.contatos)}</td><td class="num">${NUM.format(T.boletos)}</td><td class="num">${NUM.format(T.pagos)}</td><td class="num">${NUM.format(T.andamento)}</td><td class="num">${NUM.format(T.revogados)}</td><td class="num">${PCT.format(div0(T.pagos_contatos, T.contatos))}</td><td class="num">${BRL.format(T.valor)}</td><td class="num">${T.valor ? '100,0%' : ''}</td></tr>
    </tbody></table></div></div>` : ''}
  <div class="grade-2">
    <div class="card"><h3>Resultado por setor</h3><div class="tabela-wrap"><table><thead><tr><th>Setor</th><th class="num">Contatos</th><th class="num">Pagamentos</th><th class="num">Conversão</th><th class="num">Valor</th></tr></thead><tbody>
      ${R.por_setor.map(x => `<tr><td>${esc(x.setor)}</td><td class="num">${NUM.format(x.contatos)}</td><td class="num">${NUM.format(x.pagos)}</td><td class="num">${PCT.format(div0(x.pagos_contatos, x.contatos))}</td><td class="num">${BRL.format(x.valor)}</td></tr>`).join('') || '<tr><td colspan="5" class="vazio">Sem lançamentos.</td></tr>'}
    </tbody></table></div></div>
    <div class="card"><h3>Resultado por situação</h3><div class="tabela-wrap"><table><thead><tr><th>Situação</th><th>Categoria</th><th class="num">Qtde</th><th class="num">%</th></tr></thead><tbody>
      ${R.por_situacao.map(x => `<tr class="${x.qtde ? '' : 'zero'}"><td>${esc(x.situacao)}</td><td>${tag(x.categoria)}</td><td class="num">${NUM.format(x.qtde)}</td><td class="num">${PCT.format(div0(x.qtde, T.contatos))}</td></tr>`).join('')}
      <tr class="${T.sem_situacao ? '' : 'zero'}"><td>(sem situação)</td><td>${tag('Sem situação')}</td><td class="num">${NUM.format(T.sem_situacao)}</td><td class="num">${PCT.format(div0(T.sem_situacao, T.contatos))}</td></tr>
    </tbody></table></div></div>
  </div>
  <div id="eficacia">${errE ? `<div class="card"><h2>Eficácia dos meios de cobrança</h2><div class="aviso erro">Não foi possível calcular: ${esc(msgErro(errE))}</div></div>` : ''}</div>
  <div class="card"><details class="tab-dados" ${porDia ? '' : 'open'}><summary>Tabela ${porDia ? 'dia a dia' : 'mês a mês'} (dados dos gráficos)</summary>
    <div class="tabela-wrap"><table><thead><tr><th>${porDia ? 'Dia' : 'Mês'}</th><th class="num">Contatos</th><th class="num">Boletos</th><th class="num">Pagamentos</th><th class="num">Valor arrecadado</th></tr></thead><tbody>
    ${serie.map(s => `<tr class="${s.contatos || s.pagos ? '' : 'zero'}"><td>${porDia ? `${s.rot} <span class="dica">${diaSemana(s.chave).slice(0, 3)}</span>` : s.rot}</td><td class="num">${NUM.format(s.contatos)}</td><td class="num">${NUM.format(s.boletos)}</td><td class="num">${NUM.format(s.pagos)}</td><td class="num">${BRL.format(s.valor)}</td></tr>`).join('')}
    <tr class="total"><td>Total</td><td class="num">${NUM.format(T.contatos)}</td><td class="num">${NUM.format(T.boletos)}</td><td class="num">${NUM.format(T.pagos)}</td><td class="num">${BRL.format(T.valor)}</td></tr>
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
    { label: 'Pagamentos', data: serie.map(s => s.pagos), backgroundColor: css('--s3'), ...barra }] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: tip(false) }, scales: eixos() } }));
  S.charts.push(new Chart($('#gValor'), { type: 'bar', data: { labels: rots, datasets: [
    { label: 'Valor', data: serie.map(s => s.valor), backgroundColor: css('--s1'), ...barra }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: tip(true) }, scales: eixos(true) } }));
  const corCat = { 'Pago': css('--c-pago'), 'Em andamento': css('--c-and'), 'Revogado': css('--c-rev'), 'Outros': css('--c-out'), 'Sem situação': css('--c-sem') };
  S.charts.push(new Chart($('#gCat'), { type: 'bar', data: { labels: cats.map(x => catNome(x.c)), datasets: [
    { label: 'Contatos', data: cats.map(x => x.q), backgroundColor: cats.map(x => corCat[x.c]), ...barra, maxBarThickness: 22 }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: tip(false) }, scales: eixos(false, true) } }));
  S.charts.push(new Chart($('#gRev'), { type: 'bar', data: { labels: revs.map(x => { const t = x.situacao.replace(/^(REVOGADO|SEM SUCESSO)\s*[–-]\s*/, '').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); }), datasets: [
    { label: 'Sem sucesso', data: revs.map(x => x.qtde), backgroundColor: css('--c-rev'), ...barra, maxBarThickness: 22 }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: tip(false) }, scales: eixos(false, true) } }));
  if (E && !errE) desenharEficacia(E, { css, barra, eixos });
}

// ---------------------------------------------------------------- EFICÁCIA DOS MEIOS
const AMOSTRA_MIN = 20;     // abaixo disso, a linha é marcada como "amostra pequena"
const AMOSTRA_BOA = 100;    // total de contatos a partir do qual as conclusões ficam mais firmes
function htmlFunil(F, T) {
  if (!F || !F.resumo || !F.resumo.contatos) return '';
  const R = F.resumo, tot = R.contatos;
  const conv = (a, b) => PCT.format(div0(a, b));
  const linha = (rot, n, det, cor, nivel = 0) => `<div class="funil-linha" style="--nivel:${nivel}">
      <div class="funil-rot">${rot}${det ? `<span class="dica">${det}</span>` : ''}</div>
      <div class="funil-barra"><span style="width:${Math.max(div0(n, tot) * 100, n ? 1.5 : 0).toFixed(1)}%;background:var(${cor})"></span></div>
      <div class="funil-num"><strong>${NUM.format(n)}</strong> <span class="dica">${conv(n, tot)}</span></div></div>`;
  const avisos = [];
  if (R.wpp_nao_informado) avisos.push(`${NUM.format(R.wpp_nao_informado)} contato(s) sem o status do WhatsApp informado.`);
  if (R.pagos_so_enviado) avisos.push(`${NUM.format(R.pagos_so_enviado)} pagamento(s) com o WhatsApp só como "Enviado". Se o contribuinte respondeu, atualize para "Respondido" para a taxa de resposta ficar correta.`);
  const peq = n => (n < AMOSTRA_MIN ? ' <span class="dica" title="Poucos casos: resultado pouco confiável">*</span>' : '');
  const statusRot = { 'Respondido': 'Respondeu', 'Enviado': 'Enviado, sem resposta', 'Sem WhatsApp': 'Sem WhatsApp', 'Não informado': 'Não informado' };
  const st2 = [...new Set(F.etapa2.map(x => x.status_wpp))];
  return `<div class="card"><h3 style="margin-top:0">Funil a partir do WhatsApp</h3>
    <p class="dica">O primeiro contato é sempre via WhatsApp (etapa 1). SMS, ligação e agendamento formam a 2ª etapa. "Resolvido no WhatsApp" = pago usando só o WhatsApp, ou com o meio do acordo informado como WhatsApp.</p>
    ${avisos.map(a => `<div class="aviso atencao">${esc(a)}</div>`).join('')}
    <div class="funil">
      ${linha('Contatos no período', tot, '', '--s1')}
      ${linha('WhatsApp enviado', R.wpp_enviado, 'etapa 1', '--s1', 1)}
      ${linha('Responderam no WhatsApp', R.wpp_respondeu, `${conv(R.wpp_respondeu, R.wpp_enviado)} dos enviados`, '--s2', 2)}
      ${linha('Resolvidos no WhatsApp (pagos)', R.resolvidos_wpp, '', '--c-pago', 3)}
      ${linha('Foram para a 2ª etapa', R.foram_2a, 'SMS, ligação ou agendamento', '--s1', 1)}
      ${linha('Recuperados na 2ª etapa (pagos)', R.recuperados_2a, `${conv(R.recuperados_2a, R.foram_2a)} dos que foram para a 2ª etapa`, '--c-pago', 3)}
      ${R.pagos_fora_funil ? linha('Pagos sem WhatsApp efetivo nem 2ª etapa', R.pagos_fora_funil, 'ex.: sem WhatsApp e o contribuinte procurou', '--c-pago', 1) : ''}
      ${linha('Ainda em andamento', R.andamento, '', '--c-and', 1)}
      ${linha('Sem sucesso', R.sem_sucesso, '', '--c-rev', 1)}
      ${R.sem_wpp ? linha('Sem WhatsApp (número sem WhatsApp)', R.sem_wpp, '', '--c-sem', 1) : ''}
    </div></div>
  <div class="grade-2">
    <div class="card"><h3>Etapa 1 – resultado conforme o WhatsApp</h3><div class="tabela-wrap"><table><thead><tr><th>WhatsApp</th><th class="num">Contatos</th><th class="num">Só WhatsApp</th><th class="num">Resolvidos no WhatsApp</th><th class="num">Foram p/ 2ª etapa</th><th class="num">Pagos (total)</th><th class="num">Conversão</th></tr></thead><tbody>
      ${F.etapa1.map(x => `<tr><td>${esc(statusRot[x.status] || x.status)}${peq(x.contatos)}</td><td class="num">${NUM.format(x.contatos)}</td><td class="num">${NUM.format(x.so_wpp)}</td><td class="num">${NUM.format(x.resolvidos_wpp)}</td><td class="num">${NUM.format(x.foram_2a)}</td><td class="num">${NUM.format(x.pagos)}</td><td class="num"><strong>${conv(x.pagos, x.contatos)}</strong></td></tr>`).join('')}
    </tbody></table></div></div>
    <div class="card"><h3>Etapa 2 – qual meio recuperou o caso</h3><p class="dica">Conversão de cada meio da 2ª etapa, conforme o que aconteceu no WhatsApp.</p><div class="tabela-wrap"><table><thead><tr><th>Situação no WhatsApp</th><th>Meio da 2ª etapa</th><th class="num">Contatos</th><th class="num">Pagos</th><th class="num">Conversão</th></tr></thead><tbody>
      ${st2.map(st => F.etapa2.filter(x => x.status_wpp === st).map((x, i) => `<tr><td>${i ? '' : esc(statusRot[st] || st)}</td><td>${esc(x.meio)}${peq(x.contatos)}</td><td class="num">${NUM.format(x.contatos)}</td><td class="num">${NUM.format(x.pagos)}</td><td class="num"><strong>${conv(x.pagos, x.contatos)}</strong></td></tr>`).join('')).join('') || '<tr><td colspan="5" class="vazio">Nenhum caso foi para a 2ª etapa.</td></tr>'}
    </tbody></table></div></div>
  </div>`;
}

function desenharEficacia(E, { css, barra, eixos }) {
  const box = $('#eficacia'); if (!box) return;
  const T = E.total;
  const conv = (a, b) => PCT.format(div0(a, b));
  const dias = v => (v == null ? '—' : `${DEC.format(v)} dia(s)`);
  const peq = n => (n < AMOSTRA_MIN ? ' <span class="dica" title="Poucos casos: resultado pouco confiável">*</span>' : '');
  const vazio = (cols, txt = 'Sem lançamentos no período.') => `<tr><td colspan="${cols}" class="vazio">${txt}</td></tr>`;
  const k = (rot, val, det = '', cls = '') => `<div class="kpi ${cls}"><div class="rot">${rot}</div><div class="val">${val}</div>${det ? `<div class="det">${det}</div>` : ''}</div>`;

  if (!T.contatos) { box.innerHTML = `<div class="card"><h2>Eficácia dos meios de cobrança</h2><p class="vazio">Sem contatos no período.</p></div>`; return; }

  const meios = E.por_meio.filter(m => m.meio !== 'Nenhuma ação registrada');
  const elegiveis = meios.filter(m => m.contatos >= AMOSTRA_MIN);
  const melhor = (elegiveis.length ? elegiveis : meios).slice().sort((a, b) => div0(b.pagos, b.contatos) - div0(a.pagos, a.contatos) || b.contatos - a.contatos)[0];
  const combosBons = E.combinacoes.filter(c => c.contatos >= AMOSTRA_MIN && c.combinacao !== 'Nenhuma ação registrada');
  const combos = combosBons.length ? combosBons : E.combinacoes.filter(c => c.contatos >= 3 && c.combinacao !== 'Nenhuma ação registrada');
  const melhorCombo = combos.slice().sort((a, b) => div0(b.pagos, b.contatos) - div0(a.pagos, a.contatos) || b.contatos - a.contatos)[0];

  // matriz setor × meio
  const setores = [...new Set(E.por_setor_meio.map(x => x.setor))];
  const colMeios = ['WhatsApp', 'SMS', 'Ligação', 'Agendamento'];
  const cel = (st, me) => E.por_setor_meio.find(x => x.setor === st && x.meio === me);
  const dows = [1, 2, 3, 4, 5, 6, 0].map(d => E.por_dia_semana.find(x => x.dow === d) || { dow: d, contatos: 0, respondeu: 0, pagos: 0 }).filter(x => x.contatos || (x.dow >= 1 && x.dow <= 5));

  box.innerHTML = `
  <div class="card"><h2 style="margin-top:0">Eficácia dos meios de cobrança</h2>
    <p class="dica">Considera os <strong>contatos do período</strong> (data do contato) e a <strong>situação atual</strong> de cada um. Um mesmo contato pode ter usado mais de um meio, por isso as linhas não somam o total. "Conversão" = contatos que terminaram pagos ÷ contatos que usaram aquele meio.</p>
    ${T.contatos < AMOSTRA_BOA ? `<div class="aviso atencao">Amostra ainda pequena (${NUM.format(T.contatos)} contato(s)). Use estes números como indicação; as conclusões ficam mais firmes a partir de ~${AMOSTRA_BOA} contatos. Linhas com <strong>*</strong> têm menos de ${AMOSTRA_MIN} casos.</div>` : ''}
  </div>
  ${htmlFunil(E.funil, T)}
  <div class="kpis">
    ${k('Meio com maior conversão', melhor ? esc(melhor.meio) : '—', melhor ? `${conv(melhor.pagos, melhor.contatos)} de conversão em ${NUM.format(melhor.contatos)} contato(s)` : '', 'destaque')}
    ${k('Melhor combinação', melhorCombo ? esc(melhorCombo.combinacao) : '—', melhorCombo ? `${conv(melhorCombo.pagos, melhorCombo.contatos)} em ${NUM.format(melhorCombo.contatos)} contato(s)` : 'mínimo de 3 contatos')}
    ${k('Taxa de resposta', conv(T.respondeu, T.contatos), 'respondeu WhatsApp/SMS ou atendeu a ligação')}
    ${k('Contato falho', conv(T.contato_falho, T.contatos), 'número errado ou sem WhatsApp')}
    ${k('Tempo até o pagamento', dias(T.dias_medio), 'média entre o contato e o pagamento')}
  </div>
  <div class="grade-2">
    <div class="card"><h3>Conversão por meio utilizado</h3>
      <div class="grafico"><canvas id="gMeio" role="img" aria-label="Conversão por meio de cobrança"></canvas></div></div>
    <div class="card"><h3>Conversão por dia da semana do contato</h3>
      <div class="grafico"><canvas id="gDow" role="img" aria-label="Conversão por dia da semana"></canvas></div></div>
  </div>
  <div class="card"><h3>Resultado por meio utilizado</h3><div class="tabela-wrap"><table><thead><tr><th>Meio</th><th class="num">Contatos</th><th class="num">Responderam</th><th class="num">Taxa de resposta</th><th class="num">Pagos</th><th class="num">Conversão</th><th class="num">Sem sucesso</th><th class="num">Valor recebido</th><th class="num">Tempo até pagar</th></tr></thead><tbody>
    ${E.por_meio.map(m => `<tr><td>${esc(m.meio)}${peq(m.contatos)}</td><td class="num">${NUM.format(m.contatos)}</td><td class="num">${NUM.format(m.respondeu)}</td><td class="num">${conv(m.respondeu, m.contatos)}</td><td class="num">${NUM.format(m.pagos)}</td><td class="num"><strong>${conv(m.pagos, m.contatos)}</strong></td><td class="num">${NUM.format(m.sem_sucesso)}</td><td class="num">${BRL.format(m.valor)}</td><td class="num">${dias(m.dias_medio)}</td></tr>`).join('') || vazio(9)}
  </tbody></table></div></div>
  <div class="grade-2">
    <div class="card"><h3>Respondeu x só enviado</h3><p class="dica">Quanto o resultado muda conforme a resposta obtida em cada meio.</p><div class="tabela-wrap"><table><thead><tr><th>Meio</th><th>Resultado do contato</th><th class="num">Contatos</th><th class="num">Pagos</th><th class="num">Conversão</th></tr></thead><tbody>
      ${E.por_resposta.map(x => `<tr><td>${esc(x.meio)}</td><td>${esc(x.resp)}${peq(x.contatos)}</td><td class="num">${NUM.format(x.contatos)}</td><td class="num">${NUM.format(x.pagos)}</td><td class="num"><strong>${conv(x.pagos, x.contatos)}</strong></td></tr>`).join('') || vazio(5)}
    </tbody></table></div></div>
    <div class="card"><h3>Combinações de meios</h3><p class="dica">Exatamente quais meios foram usados no mesmo contato.</p><div class="tabela-wrap"><table><thead><tr><th>Combinação</th><th class="num">Contatos</th><th class="num">Pagos</th><th class="num">Conversão</th><th class="num">Valor</th><th class="num">Tempo até pagar</th></tr></thead><tbody>
      ${E.combinacoes.slice(0, 12).map(c => `<tr><td>${esc(c.combinacao)}${peq(c.contatos)}</td><td class="num">${NUM.format(c.contatos)}</td><td class="num">${NUM.format(c.pagos)}</td><td class="num"><strong>${conv(c.pagos, c.contatos)}</strong></td><td class="num">${BRL.format(c.valor)}</td><td class="num">${dias(c.dias_medio)}</td></tr>`).join('') || vazio(6)}
    </tbody></table></div></div>
  </div>
  <div class="grade-2">
    <div class="card"><h3>Qualidade das fontes de telefone</h3><p class="dica">"Contato falho" = número errado ou sem WhatsApp.</p><div class="tabela-wrap"><table><thead><tr><th>Fonte</th><th class="num">Contatos</th><th class="num">Resposta</th><th class="num">Contato falho</th><th class="num">Pagos</th><th class="num">Conversão</th><th class="num">Valor</th></tr></thead><tbody>
      ${E.por_fonte.map(x => `<tr><td>${esc(x.fonte)}${peq(x.contatos)}</td><td class="num">${NUM.format(x.contatos)}</td><td class="num">${conv(x.respondeu, x.contatos)}</td><td class="num">${conv(x.contato_falho, x.contatos)}</td><td class="num">${NUM.format(x.pagos)}</td><td class="num"><strong>${conv(x.pagos, x.contatos)}</strong></td><td class="num">${BRL.format(x.valor)}</td></tr>`).join('') || vazio(7)}
    </tbody></table></div></div>
    <div class="card"><h3>Meio que gerou o acordo</h3><p class="dica">Informado pelo funcionário no lançamento. ${NUM.format(T.pagos_com_meio)} de ${NUM.format(T.pagos)} pagamento(s) com o meio informado.</p><div class="tabela-wrap"><table><thead><tr><th>Meio</th><th class="num">Acordos</th><th class="num">Já pagos</th><th class="num">Valor</th><th class="num">Tempo até pagar</th></tr></thead><tbody>
      ${E.meio_acordo.map(x => `<tr><td>${esc(x.meio)}${peq(x.acordos)}</td><td class="num">${NUM.format(x.acordos)}</td><td class="num">${NUM.format(x.pagos)}</td><td class="num">${BRL.format(x.valor)}</td><td class="num">${dias(x.dias_medio)}</td></tr>`).join('') || vazio(5, 'Nenhum lançamento com o campo "Meio que gerou o acordo" preenchido.')}
    </tbody></table></div></div>
  </div>
  <div class="card"><h3>Conversão por setor e meio</h3><p class="dica">Em cada célula: conversão (pagos/contatos que usaram o meio naquele setor).</p><div class="tabela-wrap"><table><thead><tr><th>Setor</th>${colMeios.map(m => `<th class="num">${m}</th>`).join('')}</tr></thead><tbody>
    ${setores.map(st => `<tr><td>${esc(st)}</td>${colMeios.map(me => { const c = cel(st, me); return c ? `<td class="num"><strong>${conv(c.pagos, c.contatos)}</strong> <span class="dica">${c.pagos}/${c.contatos}</span></td>` : '<td class="num zero">—</td>'; }).join('')}</tr>`).join('') || vazio(5)}
  </tbody></table></div></div>`;

  const pct = v => PCT.format(v);
  const tipPct = { callbacks: { label: c => `${c.dataset.label}: ${pct(c.parsed.x ?? c.parsed.y)}` } };
  const eixoPct = horizontal => { const e = eixos(false, horizontal); const ax = horizontal ? e.x : e.y; ax.ticks = { callback: v => pct(v) }; ax.suggestedMax = 1; return e; };
  S.charts.push(new Chart($('#gMeio'), { type: 'bar', data: { labels: E.por_meio.map(m => m.meio), datasets: [
    { label: 'Taxa de resposta', data: E.por_meio.map(m => div0(m.respondeu, m.contatos)), backgroundColor: css('--s2'), ...barra, maxBarThickness: 18 },
    { label: 'Conversão (pagos)', data: E.por_meio.map(m => div0(m.pagos, m.contatos)), backgroundColor: css('--c-pago'), ...barra, maxBarThickness: 18 }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'bottom' }, tooltip: tipPct }, scales: eixoPct(true) } }));
  S.charts.push(new Chart($('#gDow'), { type: 'bar', data: { labels: dows.map(d => SEMANA[d.dow].replace('-feira', '')), datasets: [
    { label: 'Taxa de resposta', data: dows.map(d => div0(d.respondeu, d.contatos)), backgroundColor: css('--s2'), ...barra },
    { label: 'Conversão (pagos)', data: dows.map(d => div0(d.pagos, d.contatos)), backgroundColor: css('--c-pago'), ...barra }] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: true, position: 'bottom' }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${pct(c.parsed.y)}`, afterBody: it => `Contatos: ${NUM.format(dows[it[0].dataIndex].contatos)}` } } }, scales: eixoPct(false) } }));
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
   ['Boletos gerados', T.boletos], ['Valor dos boletos gerados', n(T.valor_boletos || 0)], ['Contatos do período já pagos', T.pagos_contatos || 0], ['Pagamentos no período (data do pagamento)', T.pagos], ['Em andamento', T.andamento], ['Sem sucesso', T.revogados], ['Outros', T.outros], ['Sem situação', T.sem_situacao],
   ['Valor arrecadado (data do pagamento)', n(T.valor)], ['Parcelas pagas', T.parcelas], ['Conversão dos contatos (%)', n((div0(T.pagos_contatos, T.contatos) * 100).toFixed(1))],
   ['Efetividade boletos (%)', n((div0(T.pagos_contatos, T.boletos) * 100).toFixed(1))], ['Ticket médio', n(div0(T.valor, T.pagos).toFixed(2))],
   ['Cancelamento: aguardando envio', T.canc_aguardando || 0], ['Encaminhados à Recuperação de Ativos', T.canc_enviados || 0],
   ['Acordos revogados pelo setor', T.canc_cancelados || 0], ['Não revogados pelo setor', T.canc_devolvidos || 0]].forEach(x => L.push(x));
  L.push([], [porDia ? 'Dia' : 'Mês', 'Contatos', 'Boletos', 'Pagamentos', 'Valor arrecadado']);
  serie.forEach(s => L.push([porDia ? fmtData(s.chave) : s.chave, s.contatos, s.boletos, s.pagos, n(s.valor)]));
  L.push([], ['Setor', 'Contatos', 'Pagamentos', 'Valor arrecadado']); R.por_setor.forEach(s => L.push([s.setor, s.contatos, s.pagos, n(s.valor)]));
  L.push([], ['Situação', 'Categoria', 'Qtde']); R.por_situacao.forEach(s => L.push([s.situacao, s.categoria, s.qtde])); L.push(['(sem situação)', 'Sem situação', T.sem_situacao]);
  if (ULTIMO.E && ULTIMO.E.total.contatos) {
    const E = ULTIMO.E; const pc = (a, b) => n((div0(a, b) * 100).toFixed(1));
    L.push([], ['EFICÁCIA DOS MEIOS (contatos do período, situação atual)']);
    if (E.funil && E.funil.resumo) {
      const F = E.funil, R2 = F.resumo;
      L.push([], ['FUNIL A PARTIR DO WHATSAPP', 'Quantidade', '% dos contatos']);
      [['Contatos no período', R2.contatos], ['WhatsApp enviado', R2.wpp_enviado], ['Responderam no WhatsApp', R2.wpp_respondeu], ['Resolvidos no WhatsApp (pagos)', R2.resolvidos_wpp],
       ['Foram para a 2ª etapa', R2.foram_2a], ['Recuperados na 2ª etapa (pagos)', R2.recuperados_2a], ['Pagos sem WhatsApp efetivo nem 2ª etapa', R2.pagos_fora_funil || 0], ['Ainda em andamento', R2.andamento], ['Sem sucesso', R2.sem_sucesso],
       ['Sem WhatsApp', R2.sem_wpp], ['WhatsApp não informado', R2.wpp_nao_informado]].forEach(([a, b]) => L.push([a, b, pc(b, R2.contatos)]));
      L.push([], ['Etapa 1 – WhatsApp', 'Contatos', 'Só WhatsApp', 'Resolvidos no WhatsApp', 'Foram p/ 2ª etapa', 'Pagos', 'Conversão (%)']);
      F.etapa1.forEach(x => L.push([x.status, x.contatos, x.so_wpp, x.resolvidos_wpp, x.foram_2a, x.pagos, pc(x.pagos, x.contatos)]));
      L.push([], ['Etapa 2 – situação no WhatsApp', 'Meio', 'Contatos', 'Pagos', 'Conversão (%)']);
      F.etapa2.forEach(x => L.push([x.status_wpp, x.meio, x.contatos, x.pagos, pc(x.pagos, x.contatos)]));
      L.push([]);
    }
    L.push(['Meio', 'Contatos', 'Responderam', 'Taxa de resposta (%)', 'Pagos', 'Conversão (%)', 'Sem sucesso', 'Valor recebido', 'Dias até pagar (média)']);
    E.por_meio.forEach(m => L.push([m.meio, m.contatos, m.respondeu, pc(m.respondeu, m.contatos), m.pagos, pc(m.pagos, m.contatos), m.sem_sucesso, n(m.valor), m.dias_medio == null ? '' : n(m.dias_medio)]));
    L.push([], ['Meio', 'Resultado do contato', 'Contatos', 'Pagos', 'Conversão (%)']);
    E.por_resposta.forEach(x => L.push([x.meio, x.resp, x.contatos, x.pagos, pc(x.pagos, x.contatos)]));
    L.push([], ['Combinação de meios', 'Contatos', 'Pagos', 'Conversão (%)', 'Valor', 'Dias até pagar (média)']);
    E.combinacoes.forEach(c => L.push([c.combinacao, c.contatos, c.pagos, pc(c.pagos, c.contatos), n(c.valor), c.dias_medio == null ? '' : n(c.dias_medio)]));
    L.push([], ['Fonte do telefone', 'Contatos', 'Resposta (%)', 'Contato falho (%)', 'Pagos', 'Conversão (%)', 'Valor']);
    E.por_fonte.forEach(x => L.push([x.fonte, x.contatos, pc(x.respondeu, x.contatos), pc(x.contato_falho, x.contatos), x.pagos, pc(x.pagos, x.contatos), n(x.valor)]));
    L.push([], ['Meio que gerou o acordo', 'Acordos', 'Já pagos', 'Valor', 'Dias até pagar (média)']);
    E.meio_acordo.forEach(x => L.push([x.meio, x.acordos, x.pagos, n(x.valor), x.dias_medio == null ? '' : n(x.dias_medio)]));
    L.push([], ['Setor', 'Meio', 'Contatos', 'Pagos', 'Conversão (%)']);
    E.por_setor_meio.forEach(x => L.push([x.setor, x.meio, x.contatos, x.pagos, pc(x.pagos, x.contatos)]));
    L.push([], ['Dia da semana', 'Contatos', 'Responderam', 'Pagos', 'Conversão (%)']);
    E.por_dia_semana.forEach(x => L.push([SEMANA[x.dow], x.contatos, x.respondeu, x.pagos, pc(x.pagos, x.contatos)]));
  }
  if (ehSup()) { L.push([], ['Funcionário', 'Dias', 'Contatos', 'Boletos', 'Pagos', 'Em andamento', 'Sem sucesso', 'Valor']); R.por_funcionario.forEach(f => L.push([f.nome, f.dias, f.contatos, f.boletos, f.pagos, f.andamento, f.revogados, n(f.valor)])); }
  const csv = '﻿' + L.map(r => r.map(c => { c = String(c ?? ''); return /[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c; }).join(';')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `relatorio_cobrancas_${p.ini}_a_${p.fim}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- CANCELAMENTOS
const CANC_CLASSE = { 'Aguardando envio': 'Em-andamento', 'Retirado': 'Sem-situacao', 'Enviado': 'Outros', 'Cancelado': 'Revogado', 'Devolvido': 'Pago' };
// nomes internos → como aparece para o usuário
const CANC_LABEL = { 'Aguardando envio': 'Aguardando envio', 'Retirado': 'Retirado da fila', 'Enviado': 'Enviado – aguardando resposta do setor', 'Cancelado': 'Acordo revogado pelo setor', 'Devolvido': 'Não revogado pelo setor' };
const cancNome = st => CANC_LABEL[st] || st;
const tagCanc = r => r && r.cancelamento_status
  ? `<div><span class="tag ${CANC_CLASSE[r.cancelamento_status] || 'Outros'}">Cancelamento: ${esc(cancNome(r.cancelamento_status))}</span></div>` : '';
const diaSemanaNum = iso => dt(iso).getUTCDay();          // 0 = domingo … 4 = quinta
function proximaQuinta(iso = hoje()) { let d = iso; while (diaSemanaNum(d) !== 4) d = addDias(d, 1); return d; }

// ---------------------------------------------------------------- vencimento de boletos
const PRAZO_UTEIS = 2;   // dias úteis de compensação bancária após o vencimento
const sitConfere = cod => !!cod && !!S.situacoes.find(s => s.codigo === cod && s.confere_vencimento);
function addDiasUteis(iso, n) {   // sábados e domingos não contam (feriados não são considerados)
  let d = iso, c = 0;
  while (c < n) { d = addDias(d, 1); const w = diaSemanaNum(d); if (w !== 0 && w !== 6) c++; }
  return d;
}
// 'conferir' | 'compensacao' | 'aberto' | null
function statusVenc(r) {
  if (!r || !r.boleto_vencimento || !sitConfere(r.situacao)) return null;
  const h = hoje();
  if (h <= r.boleto_vencimento) return 'aberto';
  return h >= addDiasUteis(r.boleto_vencimento, PRAZO_UTEIS) ? 'conferir' : 'compensacao';
}
const diasDesde = iso => Math.round((dt(hoje()) - dt(iso)) / 864e5);
function tagVenc(r) {
  const st = statusVenc(r);
  if (st === 'conferir') return `<div><span class="tag Revogado">⚠ Vencido há ${diasDesde(r.boleto_vencimento)} dia(s) – conferir pagamento</span></div>`;
  if (st === 'compensacao') return `<div><span class="tag Em-andamento">Vencido – aguardando compensação até ${fmtData(addDiasUteis(r.boleto_vencimento, PRAZO_UTEIS))}</span></div>`;
  return '';
}
// ---------------------------------------------------------------- agendamentos vencidos
// Caso ainda "em andamento" (ou sem situação) com data de agendamento já passada: conferir se a pessoa compareceu.
// Situações de boleto (Confere vencimento) ficam de fora: elas já têm o aviso próprio.
const codsAgend = () => S.situacoes.filter(s => s.categoria === 'Em andamento' && !s.confere_vencimento).map(s => s.codigo);
function statusAgend(r) {   // 'conferir' | 'hoje' | 'futuro' | null
  if (!r || !r.agendamento) return null;
  if (r.situacao && !codsAgend().includes(r.situacao)) return null;
  const h = hoje();
  return r.agendamento < h ? 'conferir' : r.agendamento === h ? 'hoje' : 'futuro';
}
function tagAgend(r) {
  const st = statusAgend(r);
  if (st === 'conferir') return `<div><span class="tag Revogado">⚠ Agendamento de ${fmtData(r.agendamento)} passou – conferir comparecimento</span></div>`;
  if (st === 'hoje') return `<div><span class="tag Em-andamento">Agendado para hoje</span></div>`;
  return '';
}
async function buscarAgendamentosAConferir(todos = false) {
  const cods = codsAgend().map(c => `"${c.replace(/"/g, '')}"`);
  let q = sb.from('lancamentos').select('*').not('agendamento', 'is', null).lt('agendamento', hoje())
    .or(`situacao.is.null${cods.length ? `,situacao.in.(${cods.join(',')})` : ''}`).order('agendamento').limit(2000);
  if (!todos) q = q.eq('funcionario_id', S.user.id);
  const { data, error } = await q;
  if (error) return [];
  return (data || []).filter(r => statusAgend(r) === 'conferir');
}

// boletos a conferir do próprio usuário (ou de todos, para a supervisão)
async function buscarBoletosAConferir(todos = false) {
  if (!S.situacoes.some(s => s.confere_vencimento)) return [];
  let q = sb.from('lancamentos').select('*').not('boleto_vencimento', 'is', null).lt('boleto_vencimento', hoje())
    .in('situacao', S.situacoes.filter(s => s.confere_vencimento).map(s => s.codigo)).order('boleto_vencimento').limit(2000);
  if (!todos) q = q.eq('funcionario_id', S.user.id);
  const { data, error } = await q;
  if (error) return [];
  return (data || []).filter(r => statusVenc(r) === 'conferir');
}

async function atualizarAvisoGlobal() {
  const box = $('#avisoGlobal'); if (!box) return;
  const msgs = [];
  // boletos vencidos do próprio usuário
  const [meus, agend] = await Promise.all([buscarBoletosAConferir(false), buscarAgendamentosAConferir(false)]);
  const link = document.querySelector('#menu a[data-rota="pendentes"]');
  const nTot = meus.length + agend.length;
  if (link) link.innerHTML = 'Pendentes' + (nTot ? ` <span class="badge" title="${meus.length} boleto(s) vencido(s) e ${agend.length} agendamento(s) vencido(s) para conferir">${nTot}</span>` : '');
  if (meus.length) msgs.push(`⚠ Você tem <strong>${meus.length}</strong> boleto(s) vencido(s) para conferir se foram pagos. <a href="#/pendentes?filtro=venc">Conferir agora</a>`);
  if (agend.length) msgs.push(`📅 Você tem <strong>${agend.length}</strong> agendamento(s) cuja data já passou. Confira se a pessoa compareceu e atualize a situação. <a href="#/pendentes?filtro=agend">Conferir agora</a>`);
  // lembrete de quinta-feira (supervisão)
  if (ehSup()) {
    const dow = diaSemanaNum(hoje());
    if (dow === 3 || dow === 4) {
      const { count } = await sb.from('lancamentos').select('id', { count: 'exact', head: true }).eq('cancelamento_status', 'Aguardando envio');
      if (count) msgs.push(`📋 ${dow === 4 ? 'Hoje é quinta-feira' : 'Amanhã é quinta-feira'}: há <strong>${count}</strong> caso(s) aguardando o relatório de cancelamento para a Recuperação de Ativos. <a href="#/cancelamentos">Abrir cancelamentos</a>`);
    }
  }
  box.innerHTML = msgs.map(m => `<div>${m}</div>`).join('');
  box.hidden = !msgs.length;
}

async function telaCancelamentos(params) {
  if (params.lote) return telaLote(params.lote);
  const nomes = Object.fromEntries(S.perfis.map(p => [p.id, p.nome]));

  if (!ehSup()) {
    app().innerHTML = `<div class="cab"><div><h1>Cancelamentos</h1><p class="sub">Seus casos com a situação "Enviar para cancelamento" e o andamento junto à Recuperação de Ativos. O relatório semanal é gerado pela supervisão às quintas-feiras.</p></div></div>
      <div class="card"><div class="tabela-wrap"><table><thead><tr><th>Data do contato</th><th>Id parc.</th><th>Setor</th><th>Andamento</th><th>Lote</th><th>Retorno</th></tr></thead><tbody id="tbMeus"><tr><td colspan="6" class="vazio">Carregando…</td></tr></tbody></table></div></div>`;
    const [{ data, error }, { data: lotes }] = await Promise.all([
      sb.from('lancamentos').select('*').eq('funcionario_id', S.user.id).not('cancelamento_status', 'is', null).order('data_contato', { ascending: false }).limit(500),
      sb.from('lotes_cancelamento').select('id,numero,data_envio')
    ]);
    const tb = $('#tbMeus');
    if (error) { tb.innerHTML = `<tr><td colspan="6" class="vazio">${esc(msgErro(error))}</td></tr>`; return; }
    const L = Object.fromEntries((lotes || []).map(l => [l.id, l]));
    tb.innerHTML = (data || []).map(r => `<tr><td>${fmtData(r.data_contato)}</td><td><strong>${esc(r.id_parcelamento)}</strong></td><td>${esc(r.setor || '')}</td>
      <td>${tagCanc(r)}</td><td>${r.cancelamento_lote && L[r.cancelamento_lote] ? `${esc(L[r.cancelamento_lote].numero)} <span class="dica">${fmtData(L[r.cancelamento_lote].data_envio)}</span>` : ''}</td>
      <td class="obs">${esc(r.cancelamento_obs || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="vazio">Nenhum caso encaminhado para cancelamento.</td></tr>';
    return;
  }

  const quinta = proximaQuinta();
  app().innerHTML = `<div class="cab"><div><h1>Cancelamentos</h1><p class="sub">Casos com a situação "Enviar para cancelamento". Às quintas-feiras, um supervisor gera o relatório único da semana para a Recuperação de Ativos.</p></div>
      <div class="dica">Próxima quinta-feira: <strong>${fmtData(quinta)}</strong></div></div>
    <div class="card"><div class="cab"><h2>Aguardando envio</h2><span class="dica" id="qtdFila"></span></div>
      <div class="tabela-wrap"><table><thead><tr><th><input type="checkbox" id="marcarTodos" checked aria-label="Marcar todos"></th><th>Data do contato</th><th>Id parc.</th><th>Origem</th><th>Setor</th><th>Funcionário</th><th>Observações</th><th></th></tr></thead>
      <tbody id="tbFila"><tr><td colspan="8" class="vazio">Carregando…</td></tr></tbody></table></div>
      <div class="linha" style="margin-top:.8rem">
        <label class="campo" style="flex:1">Observação do relatório (opcional)<input id="obsLote" maxlength="500" placeholder="Ex.: casos sem possibilidade de renegociação – semana de 20 a 24/10"></label>
        <button class="btn prim" id="btnGerar" disabled>Gerar relatório da semana</button>
      </div>
      <p class="dica">Ao gerar, os casos marcados recebem o número do lote e passam para "Enviado". Cada caso só pode ir em um lote.</p></div>
    <div class="card"><div class="cab"><h2>Aguardando resposta da Recuperação de Ativos</h2><span class="dica" id="qtdResp"></span></div>
      <p class="dica">Casos já enviados. Quando o setor responder, registre aqui se o acordo foi revogado ou não.</p>
      <div class="tabela-wrap"><table><thead><tr><th>Lote</th><th>Enviado em</th><th class="num">Dias</th><th>Id parc.</th><th>Setor</th><th>Funcionário</th><th></th></tr></thead>
      <tbody id="tbResp"></tbody></table></div></div>
    <div class="card"><details id="detRet"><summary><strong>Retirados da fila</strong> <span class="dica" id="qtdRet"></span></summary>
      <div class="tabela-wrap"><table><thead><tr><th>Data do contato</th><th>Id parc.</th><th>Funcionário</th><th>Motivo da retirada</th><th></th></tr></thead><tbody id="tbRet"></tbody></table></div></details></div>
    <div class="card"><h2>Relatórios enviados (lotes)</h2>
      <div class="tabela-wrap"><table><thead><tr><th>Lote</th><th>Enviado em</th><th>Gerado por</th><th class="num">Casos</th><th class="num">Revogados</th><th class="num">Não revogados</th><th class="num">Aguardando resposta</th><th></th></tr></thead>
      <tbody id="tbLotes"><tr><td colspan="8" class="vazio">Carregando…</td></tr></tbody></table></div></div>`;

  const [fila, ret, lotes, env, resp] = await Promise.all([
    sb.from('lancamentos').select('*').eq('cancelamento_status', 'Aguardando envio').order('data_contato').order('id').limit(1000),
    sb.from('lancamentos').select('*').eq('cancelamento_status', 'Retirado').order('data_contato', { ascending: false }).limit(200),
    sb.from('lotes_cancelamento').select('*').order('id', { ascending: false }).limit(200),
    sb.from('lancamentos').select('cancelamento_lote,cancelamento_status').not('cancelamento_lote', 'is', null).limit(10000),
    sb.from('lancamentos').select('*').eq('cancelamento_status', 'Enviado').order('cancelamento_lote').order('id').limit(2000)
  ]);
  const err = fila.error || ret.error || lotes.error || env.error || resp.error;
  if (err) { $('#tbFila').innerHTML = `<tr><td colspan="8" class="vazio">${esc(msgErro(err))}</td></tr>`; return; }

  // fila
  const F = fila.data || [];
  $('#qtdFila').textContent = `${F.length} caso(s)`;
  const btn = $('#btnGerar');
  const atualizarBotao = () => { const n = $$('#tbFila input[data-id]:checked').length; btn.disabled = !n; btn.textContent = n ? `Gerar relatório da semana (${n} caso${n > 1 ? 's' : ''})` : 'Gerar relatório da semana'; };
  $('#tbFila').innerHTML = F.map(r => `<tr><td><input type="checkbox" data-id="${r.id}" checked aria-label="Incluir no relatório"></td><td>${fmtData(r.data_contato)}</td>
      <td><strong>${esc(r.id_parcelamento)}</strong></td><td>${esc(r.origem || '')}</td><td>${esc(r.setor || '')}</td><td>${esc(nomes[r.funcionario_id] || '—')}</td>
      <td class="obs">${esc(r.observacoes || '')}</td><td><button class="btn peq" data-ret="${r.id}">Retirar da fila</button></td></tr>`).join('')
    || '<tr><td colspan="8" class="vazio">Nenhum caso aguardando envio.</td></tr>';
  $('#marcarTodos').addEventListener('change', e => { $$('#tbFila input[data-id]').forEach(c => (c.checked = e.target.checked)); atualizarBotao(); });
  $$('#tbFila input[data-id]').forEach(c => c.addEventListener('change', atualizarBotao));
  atualizarBotao();
  $$('#tbFila [data-ret]').forEach(b => b.addEventListener('click', async () => {
    const motivo = prompt('Motivo da retirada da fila (ex.: acordo fechado, situação revista):');
    if (motivo === null) return;
    const { error } = await sb.rpc('atualizar_cancelamento', { p_id: Number(b.dataset.ret), p_status: 'Retirado', p_obs: motivo });
    if (error) return toast(msgErro(error), true);
    toast('Caso retirado da fila.'); telaCancelamentos({}); atualizarAvisoGlobal();
  }));
  btn.addEventListener('click', async () => {
    const ids = $$('#tbFila input[data-id]:checked').map(c => Number(c.dataset.id));
    if (!ids.length) return;
    if (!confirm(`Gerar o relatório com ${ids.length} caso(s)? Eles serão marcados como "Enviado" e não voltarão para a fila.`)) return;
    btn.disabled = true;
    const { data: loteId, error } = await sb.rpc('gerar_lote_cancelamento', { p_ids: ids, p_obs: $('#obsLote').value.trim() || null });
    btn.disabled = false;
    if (error) return toast(msgErro(error), true);
    toast('Relatório gerado.'); atualizarAvisoGlobal();
    location.hash = `#/cancelamentos?lote=${loteId}`;
  });

  // retirados
  const R = ret.data || [];
  $('#qtdRet').textContent = `(${R.length})`;
  $('#tbRet').innerHTML = R.map(r => `<tr><td>${fmtData(r.data_contato)}</td><td><strong>${esc(r.id_parcelamento)}</strong></td><td>${esc(nomes[r.funcionario_id] || '—')}</td>
      <td class="obs">${esc(r.cancelamento_obs || '')}</td><td><button class="btn peq" data-vol="${r.id}">Devolver à fila</button></td></tr>`).join('')
    || '<tr><td colspan="5" class="vazio">Nenhum caso retirado.</td></tr>';
  $$('#tbRet [data-vol]').forEach(b => b.addEventListener('click', async () => {
    const { error } = await sb.rpc('atualizar_cancelamento', { p_id: Number(b.dataset.vol), p_status: 'Aguardando envio', p_obs: null });
    if (error) return toast(msgErro(error), true);
    toast('Caso devolvido à fila.'); telaCancelamentos({});
  }));

  // aguardando resposta do setor
  const LT = Object.fromEntries((lotes.data || []).map(l => [l.id, l]));
  const RS = resp.data || [];
  $('#qtdResp').textContent = `${RS.length} caso(s)`;
  $('#tbResp').innerHTML = RS.map(r => { const l = LT[r.cancelamento_lote] || {};
    return `<tr><td><a href="#/cancelamentos?lote=${r.cancelamento_lote}">${esc(l.numero || '')}</a></td><td>${fmtData(l.data_envio)}</td><td class="num">${l.data_envio ? diasDesde(l.data_envio) : ''}</td>
      <td><strong>${esc(r.id_parcelamento)}</strong></td><td>${esc(r.setor || '')}</td><td>${esc(nomes[r.funcionario_id] || '—')}</td>
      <td><div class="acoes"><button class="btn peq" data-resp="Cancelado" data-id="${r.id}">Acordo revogado</button><button class="btn peq" data-resp="Devolvido" data-id="${r.id}">Não revogado</button></div></td></tr>`; }).join('')
    || '<tr><td colspan="7" class="vazio">Nenhum caso aguardando resposta.</td></tr>';
  $$('#tbResp [data-resp]').forEach(b => b.addEventListener('click', async () => {
    let obs = null;
    if (b.dataset.resp === 'Devolvido') { obs = prompt('Motivo informado pelo setor para não revogar (opcional):'); if (obs === null) return; }
    else if (!confirm('Confirmar que a Recuperação de Ativos revogou este acordo?')) return;
    const { error } = await sb.rpc('atualizar_cancelamento', { p_id: Number(b.dataset.id), p_status: b.dataset.resp, p_obs: obs });
    if (error) return toast(msgErro(error), true);
    toast('Resposta registrada.'); telaCancelamentos({});
  }));

  // lotes
  const cont = {};
  for (const e of env.data || []) { const c = (cont[e.cancelamento_lote] ||= { Enviado: 0, Cancelado: 0, Devolvido: 0 }); c[e.cancelamento_status] = (c[e.cancelamento_status] || 0) + 1; }
  $('#tbLotes').innerHTML = (lotes.data || []).map(l => { const c = cont[l.id] || { Enviado: 0, Cancelado: 0, Devolvido: 0 };
    return `<tr><td><strong>${esc(l.numero)}</strong></td><td>${fmtData(l.data_envio)}</td><td>${esc(nomes[l.criado_por] || '—')}</td><td class="num">${l.quantidade}</td>
      <td class="num">${c.Cancelado}</td><td class="num">${c.Devolvido}</td><td class="num">${c.Enviado}</td><td><a class="btn peq" href="#/cancelamentos?lote=${l.id}">Abrir</a></td></tr>`; }).join('')
    || '<tr><td colspan="8" class="vazio">Nenhum relatório gerado ainda.</td></tr>';
}

async function telaLote(id) {
  const nomes = Object.fromEntries(S.perfis.map(p => [p.id, p.nome]));
  const [{ data: lote, error: e1 }, { data: itens, error: e2 }] = await Promise.all([
    sb.from('lotes_cancelamento').select('*').eq('id', id).maybeSingle(),
    sb.from('lancamentos').select('*').eq('cancelamento_lote', id).order('data_contato').order('id')
  ]);
  if (e1 || e2 || !lote) { app().innerHTML = `<div class="card aviso erro">${esc(e1 || e2 ? msgErro(e1 || e2) : 'Lote não encontrado.')}</div>`; return; }
  const sup = ehSup();
  const I = itens || [];
  app().innerHTML = `
  <div class="cab nao-imprimir"><div><a href="#/cancelamentos">← Voltar para Cancelamentos</a></div>
    <div class="acoes"><button class="btn" id="btnImpLote">Imprimir / salvar PDF</button><button class="btn" id="btnCsvLote">Baixar planilha (CSV)</button></div></div>
  <div class="card documento">
    <div class="doc-cab">
      <div><div class="doc-orgao">Setor de Cobrança</div><h1>Relatório de parcelamentos para cancelamento</h1></div>
      <div class="doc-num">Lote <strong>${esc(lote.numero)}</strong><br>Enviado em ${fmtData(lote.data_envio)}</div>
    </div>
    <p><strong>Destino:</strong> Setor de Recuperação de Ativos</p>
    <p>Encaminhamos os parcelamentos abaixo, para os quais não houve possibilidade de renegociação, para as providências de cancelamento.</p>
    ${lote.observacao ? `<p><strong>Observação:</strong> ${esc(lote.observacao)}</p>` : ''}
    <div class="tabela-wrap"><table><thead><tr><th>Nº</th><th>Id parcelamento</th><th>Origem / inscrição</th><th>Setor</th><th>Último contato</th><th>Responsável</th><th>Observações</th>${sup ? '<th class="nao-imprimir">Andamento</th>' : ''}</tr></thead>
    <tbody>${I.map((r, i) => `<tr data-id="${r.id}"><td>${i + 1}</td><td><strong>${esc(r.id_parcelamento)}</strong></td><td>${esc(r.origem || '')}</td><td>${esc(r.setor || '')}</td>
      <td>${fmtData(r.data_contato)}</td><td>${esc(nomes[r.funcionario_id] || '—')}</td><td class="obs">${esc(r.observacoes || '')}</td>
      ${sup ? `<td class="nao-imprimir"><div class="form-col" style="gap:.3rem;min-width:190px"><select name="st">${['Enviado', 'Cancelado', 'Devolvido'].map(o => `<option value="${o}" ${o === r.cancelamento_status ? 'selected' : ''}>${cancNome(o)}</option>`).join('')}</select>
        <input name="obs" maxlength="300" placeholder="Retorno (opcional)" value="${esc(r.cancelamento_obs || '')}"><button class="btn peq">Salvar</button></div></td>` : ''}</tr>`).join('')
      || `<tr><td colspan="8" class="vazio">Nenhum caso visível neste lote.</td></tr>`}</tbody></table></div>
    <p><strong>Total de parcelamentos: ${I.length}</strong></p>
    <div class="assinatura"><div>________________________________________</div><div>${esc(nomes[lote.criado_por] || '')}</div><div class="dica">Responsável pelo envio</div></div>
  </div>`;
  $('#btnImpLote').addEventListener('click', () => window.print());
  $('#btnCsvLote').addEventListener('click', () => {
    const L = [['Lote', lote.numero], ['Enviado em', fmtData(lote.data_envio)], ['Destino', 'Setor de Recuperação de Ativos'], [],
      ['Nº', 'Id parcelamento', 'Origem/inscrição', 'Setor', 'Último contato', 'Responsável', 'Observações', 'Andamento', 'Retorno']];
    I.forEach((r, i) => L.push([i + 1, r.id_parcelamento, r.origem || '', r.setor || '', fmtData(r.data_contato), nomes[r.funcionario_id] || '', r.observacoes || '', cancNome(r.cancelamento_status || ''), r.cancelamento_obs || '']));
    const csv = '﻿' + L.map(x => x.map(c => { c = String(c ?? ''); return /[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c; }).join(';')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `cancelamentos_lote_${lote.numero.replace('/', '-')}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  if (sup) $$('.documento tr[data-id] button').forEach(b => b.addEventListener('click', async () => {
    const tr = b.closest('tr');
    const { error } = await sb.rpc('atualizar_cancelamento', { p_id: Number(tr.dataset.id), p_status: tr.querySelector('[name=st]').value, p_obs: tr.querySelector('[name=obs]').value.trim() || null });
    if (error) return toast(msgErro(error), true);
    toast('Andamento atualizado.');
  }));
}

// ---------------------------------------------------------------- ADMINISTRAÇÃO
async function telaAdmin() {
  if (!ehAdmin()) { location.hash = '#/lancar'; return; }
  app().innerHTML = `<div class="cab"><div><h1>Administração</h1><p class="sub">Liberação de acessos, padronização das listas e auditoria.</p></div></div>
  <div class="card"><h2>Usuários</h2><p class="dica">Novos cadastros aparecem aqui como "aguardando". Marque "Ativo" e escolha o papel. Para remover alguém, desmarque "Ativo".</p>
    <div class="tabela-wrap"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Ativo</th><th></th></tr></thead><tbody id="tbUsu"></tbody></table></div></div>
  <div class="card"><h2>Situações (resultado)</h2><p class="dica">A categoria define como a situação entra nos relatórios. <strong>Excluir</strong> só é possível para situações nunca usadas; as que já aparecem em lançamentos são <strong>desativadas</strong> (somem das listas, mas o histórico e os relatórios antigos continuam corretos).</p>
    <label class="check-linha"><input type="checkbox" id="verInativas"> Mostrar situações desativadas <span class="dica" id="qtdInativas"></span></label>
    <div class="tabela-wrap"><table><thead><tr><th>Situação</th><th>Categoria</th><th>Quando usar</th><th class="num">Ordem</th><th>Gera cancelamento</th><th>Confere vencimento</th><th>Ativa</th><th class="num">Em uso</th><th></th></tr></thead><tbody id="tbSit"></tbody></table></div>
    <form class="linha" id="fNovaSit" style="margin-top:.8rem">
      <label class="campo">Nova situação<input name="codigo" maxlength="60" required placeholder="EX.: SEM SUCESSO – FALECIDO"></label>
      <label class="campo">Categoria<select name="categoria">${CATEGORIAS.slice(0, 4).map(c => `<option value="${c}">${catNome(c)}</option>`).join('')}</select></label>
      <label class="campo" style="flex:1">Quando usar<input name="descricao" maxlength="200"></label>
      <label class="campo">Gera cancelamento<input type="checkbox" name="gera"></label>
      <label class="campo">Confere vencimento<input type="checkbox" name="confv"></label>
      <button class="btn prim">Adicionar</button></form>
    <p class="dica">"Gera cancelamento": ao escolher a situação, o caso entra automaticamente na fila do relatório semanal à Recuperação de Ativos. "Confere vencimento": o sistema avisa para conferir o pagamento ${PRAZO_UTEIS} dias úteis após o vencimento do boleto.</p></div>
  <div class="card"><h2>Setores</h2><div class="tabela-wrap"><table><thead><tr><th>Setor</th><th class="num">Ordem</th><th>Ativo</th><th></th></tr></thead><tbody id="tbSet"></tbody></table></div>
    <form class="linha" id="fNovoSet" style="margin-top:.8rem"><label class="campo">Novo setor<input name="nome" maxlength="40" required></label><button class="btn prim">Adicionar</button></form></div>
  <div class="card"><h2>Auditoria (últimas 200 alterações)</h2><div class="tabela-wrap"><table><thead><tr><th>Quando</th><th>Usuário</th><th>Ação</th><th>Tabela</th><th>Registro</th><th>Campos alterados</th></tr></thead><tbody id="tbAud"><tr><td colspan="6" class="vazio">Carregando…</td></tr></tbody></table></div></div>`;
  await carregarTabelas();
  // usuários
  const tbU = $('#tbUsu');
  const usus = [...S.perfis].sort((a, b) => (a.ativo - b.ativo) || a.nome.localeCompare(b.nome));
  tbU.innerHTML = usus.map(u => `<tr data-id="${u.id}"><td>${esc(u.nome)}${u.ativo ? '' : ' <span class="tag Em-andamento">aguardando</span>'}</td><td>${esc(u.email || '')}</td>
    <td><select name="papel" ${u.id === S.user.id ? 'disabled' : ''}>${['funcionario', 'supervisor', 'admin'].map(p => `<option value="${p}" ${p === u.papel ? 'selected' : ''}>${({ funcionario: 'Funcionário', supervisor: 'Supervisão (consulta + cancelamentos)', admin: 'Administrador' })[p]}</option>`).join('')}</select></td>
    <td><input type="checkbox" name="ativo" ${u.ativo ? 'checked' : ''} ${u.id === S.user.id ? 'disabled' : ''} aria-label="Ativo"></td>
    <td>${u.id === S.user.id ? '<span class="dica">você</span>' : '<button class="btn peq">Salvar</button>'}</td></tr>`).join('');
  $$('tr[data-id] button', tbU).forEach(b => b.addEventListener('click', async () => {
    const tr = b.closest('tr');
    const { error } = await sb.from('perfis').update({ papel: tr.querySelector('[name=papel]').value, ativo: tr.querySelector('[name=ativo]').checked }).eq('id', tr.dataset.id);
    if (error) return toast(msgErro(error), true); toast('Usuário atualizado.'); telaAdmin();
  }));
  // situações
  const tbS = $('#tbSit');
  const { data: usoRows } = await sb.rpc('uso_situacoes');
  const uso = Object.fromEntries((usoRows || []).map(r => [r.codigo, Number(r.qtde)]));
  let verInativas = false; try { verInativas = localStorage.getItem('adm_ver_inativas') === '1'; } catch (_) {}
  $('#verInativas').checked = verInativas;
  const desenharSit = () => {
    const inativas = S.situacoes.filter(s => !s.ativo).length;
    $('#qtdInativas').textContent = inativas ? `(${inativas})` : '(nenhuma)';
    const lista = S.situacoes.filter(s => verInativas || s.ativo);
    tbS.innerHTML = lista.map(s => { const n = uso[s.codigo] || 0; return `<tr data-cod="${esc(s.codigo)}" class="${s.ativo ? '' : 'zero'}"><td><strong>${esc(s.codigo)}</strong>${s.ativo ? '' : ' <span class="tag Sem-situacao">desativada</span>'}</td>
    <td><select name="categoria">${CATEGORIAS.slice(0, 4).map(c => `<option value="${c}" ${c === s.categoria ? 'selected' : ''}>${catNome(c)}</option>`).join('')}</select></td>
    <td><input name="descricao" value="${esc(s.descricao || '')}" maxlength="200"></td><td class="num"><input name="ordem" type="number" value="${s.ordem}" style="width:5rem"></td>
    <td><input type="checkbox" name="gera" ${s.gera_cancelamento ? 'checked' : ''} aria-label="Gera cancelamento"></td>
    <td><input type="checkbox" name="confv" ${s.confere_vencimento ? 'checked' : ''} aria-label="Confere vencimento"></td>
    <td><input type="checkbox" name="ativo" ${s.ativo ? 'checked' : ''} aria-label="Ativa"></td>
    <td class="num" title="Lançamentos com esta situação">${NUM.format(n)}</td>
    <td class="acoes-linha"><button class="btn peq" data-acao="salvar">Salvar</button>${n && !s.ativo ? '' : `<button class="btn peq perigo" data-acao="excluir" title="${n ? 'Em uso: será oferecida a desativação' : 'Excluir definitivamente'}">${n ? 'Desativar' : 'Excluir'}</button>`}</td></tr>`; }).join('')
      || '<tr><td colspan="9" class="vazio">Nenhuma situação ativa.</td></tr>';
    $$('tr[data-cod] button[data-acao=salvar]', tbS).forEach(b => b.addEventListener('click', async () => {
      const tr = b.closest('tr');
      const { error } = await sb.from('situacoes').update({ categoria: tr.querySelector('[name=categoria]').value, descricao: tr.querySelector('[name=descricao]').value.trim() || null,
        ordem: Number(tr.querySelector('[name=ordem]').value) || 100, gera_cancelamento: tr.querySelector('[name=gera]').checked, confere_vencimento: tr.querySelector('[name=confv]').checked, ativo: tr.querySelector('[name=ativo]').checked }).eq('codigo', tr.dataset.cod);
      if (error) return toast(msgErro(error), true); toast('Situação atualizada.'); await carregarTabelas(); desenharSit();
    }));
    $$('tr[data-cod] button[data-acao=excluir]', tbS).forEach(b => b.addEventListener('click', async () => {
      const cod = b.closest('tr').dataset.cod; const n = uso[cod] || 0;
      const sit = S.situacoes.find(x => x.codigo === cod) || {};
      const alerta = [sit.gera_cancelamento ? '• Ela alimenta a fila de cancelamentos para a Recuperação de Ativos.' : '', sit.confere_vencimento ? '• Ela faz o sistema avisar sobre boletos vencidos.' : '']
        .filter(Boolean); const extra = alerta.length ? `\n\nAtenção:\n${alerta.join('\n')}` : '';
      if (n) {
        if (!confirm(`A situação "${cod}" está em ${n} lançamento(s) e não pode ser excluída sem apagar o histórico.\n\nDesativá-la? Ela deixa de aparecer nas listas, mas os lançamentos e relatórios antigos continuam corretos.${extra}`)) return;
        const { error } = await sb.from('situacoes').update({ ativo: false }).eq('codigo', cod);
        if (error) return toast(msgErro(error), true); toast('Situação desativada.');
      } else {
        if (!confirm(`Excluir definitivamente a situação "${cod}"?\n\nEla nunca foi usada em lançamentos. A exclusão fica registrada na auditoria.${extra}`)) return;
        const { error } = await sb.from('situacoes').delete().eq('codigo', cod);
        if (error) return toast(msgErro(error), true); toast('Situação excluída.');
      }
      await carregarTabelas(); desenharSit();
    }));
  };
  $('#verInativas').addEventListener('change', e => { verInativas = e.target.checked; try { localStorage.setItem('adm_ver_inativas', verInativas ? '1' : '0'); } catch (_) {} desenharSit(); });
  desenharSit();
  $('#fNovaSit').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    const { error } = await sb.from('situacoes').insert({ codigo: f.codigo.value.trim().toUpperCase().replace(/\s+-\s+/g, ' – '), categoria: f.categoria.value, descricao: f.descricao.value.trim() || null, ordem: 90, gera_cancelamento: f.gera.checked, confere_vencimento: f.confv.checked });
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
