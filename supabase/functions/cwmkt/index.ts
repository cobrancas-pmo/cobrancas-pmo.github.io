// Cobranças PMO – ligação com o CWMKT (WhatsApp da Prefeitura).
// 1) Recebe os avisos (webhook) do CWMKT: quando o contribuinte da campanha escreve,
//    quando o cobrador manda o 1º WhatsApp e quando o bot passa a conversa para humano.
// 2) Reconhece o contribuinte pelo telefone embaralhado (não guarda telefone nem conteúdo).
// 3) Depois do bot, atribui a conversa: Agente = cobrador da campanha, Time = "cobrança manual",
//    Etiquetas = "cobranças_<nome>" + "campanha". Se o contribuinte escolheu outro setor no bot,
//    respeita e só coloca a etiqueta "campanha".
// 4) Modo teste (administrador logado no sistema): confere a configuração e mostra os últimos avisos.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const ENV = (k: string) => (Deno.env.get(k) || '').trim();
const BASE = ENV('CWMKT_URL').replace(/\/+$/, '');          // ex.: https://app.cwmkt.cloud
const TOKEN = ENV('CWMKT_TOKEN');                           // token de acesso de um administrador do CWMKT
const CONTA = ENV('CWMKT_CONTA');                           // nº da conta (aparece no endereço: /app/accounts/N/...)
const TIME = ENV('CWMKT_TIME') || 'cobrança manual';         // time dos cobradores
const CAIXA = ENV('CWMKT_CAIXA');                           // opcional: nº da caixa "Tributário Oficial"
// times para onde o bot manda assuntos de cobrança: a conversa da campanha é puxada para o cobrador mesmo assim (separados por vírgula)
const TIMES_ACEITOS = ENV('CWMKT_TIMES_ACEITOS').split(/[,;]/).map(t => t.trim()).filter(Boolean);
// senha que vai no endereço do webhook: a definida em CWMKT_WEBHOOK_TOKEN ou, se não houver, uma derivada da chave do projeto
let WEBHOOK_TOKEN = ENV('CWMKT_WEBHOOK_TOKEN');
const SEGREDO = ENV('CWMKT_SEGREDO');                       // opcional: segredo de assinatura do webhook
const ETIQ_CAMPANHA = 'campanha';
const SAL_HASH = 'cobrancas-pmo|';                          // o mesmo do navegador (js/campanhas.js)
const SITE = 'https://cobrancas-pmo.github.io';

const db = createClient(ENV('SUPABASE_URL'), ENV('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const cors = { 'Access-Control-Allow-Origin': SITE, 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...extra } });

// ---------- telefone → variantes embaralhadas ----------
async function sha256(t: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
}
async function hashes(phone: unknown): Promise<string[]> {
  let d = String(phone ?? '').replace(/\D/g, '');
  if (!d) return [];
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  const v = new Set<string>();
  if (d.length === 11) v.add(d);
  if (d.length === 10 && '6789'.includes(d[2])) v.add(d.slice(0, 2) + '9' + d.slice(2));   // WhatsApp às vezes vem sem o 9
  if (d.length === 11 && d[2] === '9') v.add(d);
  return Promise.all([...v].map(n => sha256(SAL_HASH + '55' + n)));
}

// ---------- API do CWMKT ----------
async function api(path: string, init: RequestInit = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(`${BASE}/api/v1/accounts/${CONTA}${path}`, {
      ...init, signal: ctl.signal,
      headers: { 'api_access_token': TOKEN, 'Content-Type': 'application/json', ...(init.headers || {}) }
    });
    const txt = await r.text();
    let body: any = null; try { body = txt ? JSON.parse(txt) : null; } catch { body = txt; }
    if (!r.ok) throw new Error(`CWMKT ${init.method || 'GET'} ${path} → ${r.status}`);
    return body;
  } finally { clearTimeout(t); }
}
const lista = (b: any) => (Array.isArray(b) ? b : Array.isArray(b?.payload) ? b.payload : []);
let cache: { agentes?: any[]; times?: any[]; etiquetas?: any[] } = {};
async function agentes() { return cache.agentes ??= lista(await api('/agents')); }
async function times() { return cache.times ??= lista(await api('/teams')); }
async function etiquetas() { return cache.etiquetas ??= lista(await api('/labels')); }

async function agenteDe(email: string | null, nome: string) {
  const ags = await agentes();
  const e = String(email || '').toLowerCase();
  let a = e && ags.find(x => String(x.email || '').toLowerCase() === e);
  if (a) return a;
  const n = norm(nome), partes = n.split(' ');
  a = ags.find(x => norm(x.name) === n) || ags.find(x => { const m = norm(x.name); return partes.length > 1 && m.includes(partes[0]) && m.includes(partes[partes.length - 1]); });
  if (a) return a;
  const mesmos = ags.filter(x => norm(x.name).split(' ')[0] === partes[0]);
  return mesmos.length === 1 ? mesmos[0] : null;
}
// time aceito: o nome do time contém o termo (ou o contrário), sem acento nem maiúsculas — "REFIS" aceita "refis 2026"
const ehAceito = (nome: unknown) => { const n = norm(nome); return !!n && TIMES_ACEITOS.some(t => { const a = norm(t); return !!a && (n.includes(a) || a.includes(n)); }); };
async function timeCobranca() { const n = norm(TIME); return (await times()).find(t => norm(t.name) === n) || null; }
async function etiquetaDe(nome: string) {
  const p = norm(nome).split(' ')[0];
  const ets = await etiquetas();
  const e = ets.find(l => { const t = norm(String(l.title || '').replace(/_/g, ' ')); return t.startsWith('cobrancas') && t.split(' ').includes(p); });
  return e ? String(e.title) : null;
}
async function garantirEtiquetaCampanha() {
  const ets = await etiquetas();
  if (ets.some(l => norm(l.title) === ETIQ_CAMPANHA)) return;
  try { await api('/labels', { method: 'POST', body: JSON.stringify({ title: ETIQ_CAMPANHA, description: 'Veio da campanha de SMS/e-mail (Sistema de Cobranças)', color: '#7A4FB5', show_on_sidebar: true }) }); cache.etiquetas = undefined; } catch { /* sem permissão: segue sem criar */ }
}
async function addEtiquetas(conv: number, novas: string[]) {
  const atuais: string[] = lista(await api(`/conversations/${conv}/labels`)).map(String);
  const todas = [...new Set([...atuais, ...novas.filter(Boolean)])];
  if (todas.length !== atuais.length) await api(`/conversations/${conv}/labels`, { method: 'POST', body: JSON.stringify({ labels: todas }) });
}

// Atribui depois do bot (conversa "aberta"). Devolve texto para o registro.
async function atribuir(conv: number, item: any): Promise<string> {
  const c = await api(`/conversations/${conv}`);
  const status = c?.status; const timeAtual = c?.meta?.team || null;
  if (status === 'pending') return 'aguardando o bot';
  if (status === 'resolved') return 'conversa já resolvida';
  await garantirEtiquetaCampanha();
  const tc = await timeCobranca();
  const aceito = timeAtual && ehAceito(timeAtual.name);
  if (timeAtual && tc && timeAtual.id !== tc.id && !aceito) {
    await addEtiquetas(conv, [ETIQ_CAMPANHA]);
    await db.rpc('cwmkt_marcar_atribuida', { p_conversa: conv });
    return `contribuinte escolheu outro setor (${String(timeAtual.name || '').slice(0, 40)}): só etiqueta`;
  }
  const ag = await agenteDe(item.email, item.nome);
  const et = await etiquetaDe(item.nome);
  if (tc && (!timeAtual || timeAtual.id !== tc.id)) await api(`/conversations/${conv}/assignments`, { method: 'POST', body: JSON.stringify({ team_id: tc.id }) });
  if (ag) await api(`/conversations/${conv}/assignments`, { method: 'POST', body: JSON.stringify({ assignee_id: ag.id }) });
  await addEtiquetas(conv, [ETIQ_CAMPANHA, et || '']);
  await db.rpc('cwmkt_marcar_atribuida', { p_conversa: conv });
  return `atribuída: ${ag ? 'agente ok' : 'AGENTE NÃO ENCONTRADO'} · ${tc ? 'time ok' : 'TIME NÃO ENCONTRADO'} · ${et ? 'etiqueta ' + et : 'etiqueta do cobrador não encontrada'}`;
}

async function registrar(evento: string, conv: number | null, phone: unknown, tipo: string, quando: string) {
  const hs = await hashes(phone);
  if (!hs.length && !conv) return null;
  const { data, error } = await db.rpc('cwmkt_registrar', { p_hashes: hs, p_tipo: tipo, p_quando: quando, p_conversa: conv });
  if (error) throw new Error(error.message);
  return data;
}
const log = (evento: string, conv: number | null, resultado: string) => db.rpc('cwmkt_log', { p_evento: evento, p_conversa: conv, p_resultado: resultado });

async function verificarAssinatura(req: Request, bruto: string) {
  if (!SEGREDO) return true;
  const sig = req.headers.get('x-chatwoot-signature'); const ts = req.headers.get('x-chatwoot-timestamp');
  if (!sig || !ts) return true;   // versão do CWMKT sem assinatura: vale só a senha do endereço
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(SEGREDO), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${ts}.${bruto}`)))).map(x => x.toString(16).padStart(2, '0')).join('');
  const esperado = 'sha256=' + mac;
  if (esperado.length !== sig.length) return false;
  let dif = 0; for (let i = 0; i < sig.length; i++) dif |= sig.charCodeAt(i) ^ esperado.charCodeAt(i);
  return dif === 0 && Math.abs(Date.now() / 1000 - Number(ts)) < 600;
}

async function senhaWebhook() {
  if (!WEBHOOK_TOKEN) WEBHOOK_TOKEN = (await sha256('cwmkt-webhook|' + ENV('SUPABASE_SERVICE_ROLE_KEY'))).slice(0, 40);
  return WEBHOOK_TOKEN;
}

async function webhook(req: Request, url: URL) {
  await senhaWebhook();
  if (!WEBHOOK_TOKEN || url.searchParams.get('t') !== WEBHOOK_TOKEN) return json({ ok: false }, 401);
  const bruto = await req.text();
  if (!(await verificarAssinatura(req, bruto))) return json({ ok: false }, 401);
  let b: any; try { b = JSON.parse(bruto); } catch { return json({ ok: false }, 400); }
  const ev = String(b?.event || '');
  cache = {};
  try {
    if (ev === 'message_created') {
      const conv = b.conversation || {};
      const convId = Number(conv.id) || null;
      const caixa = String(b.inbox?.id ?? conv.inbox_id ?? '');
      if (CAIXA && caixa !== CAIXA) return json({ ok: true, ignorado: 'outra caixa' });
      if (b.private) return json({ ok: true, ignorado: 'nota interna' });
      const mt = String(b.message_type);
      const phone = conv.meta?.sender?.phone_number || (b.sender?.type === 'contact' ? b.sender?.phone_number : null);
      const quando = b.created_at ? new Date(typeof b.created_at === 'number' ? b.created_at * 1000 : b.created_at).toISOString() : new Date().toISOString();
      let tipo = '';
      if (mt === 'incoming' || mt === '0') tipo = 'entrada';
      else if ((mt === 'outgoing' || mt === '1' || mt === 'template' || mt === '3') && (b.sender?.type === 'user' || b.sender?.type === 'User')) tipo = 'saida';
      // diagnóstico: só para conversas já ligadas a uma campanha (sem dados pessoais)
      const ligada = convId ? (await db.from('campanha_itens').select('id').eq('cwmkt_conversa', convId).limit(1)).data?.length : 0;
      const diag = `tipo=${mt} remetente=${b.sender?.type ?? '-'} fone=${phone ? 'sim' : 'não'} status=${conv.status ?? '-'}`;
      if (!tipo) { if (ligada) await log(ev, convId, 'ignorada: ' + diag); return json({ ok: true, ignorado: 'mensagem do bot ou do sistema' }); }
      const item = await registrar(ev, convId, phone, tipo, quando);
      if (!item) { if (ligada) await log(ev, convId, 'não reconhecida: ' + diag); return json({ ok: true, ignorado: 'não é de campanha' }); }
      let res = tipo === 'entrada' ? 'contribuinte respondeu' : 'cobrador mandou WhatsApp';
      if (tipo === 'entrada' && convId && !item.ja_atribuida && conv.status === 'open') res += ' · ' + await atribuir(convId, item);
      await log(ev, convId, `${item.campanha}: ${res}`);
      return json({ ok: true });
    }
    if (ev === 'conversation_status_changed' || ev === 'conversation_updated') {
      const convId = Number(b.id) || null;
      if (CAIXA && String(b.inbox_id ?? '') !== CAIXA) return json({ ok: true, ignorado: 'outra caixa' });
      if (b.status !== 'open' || !convId) return json({ ok: true, ignorado: 'não abriu' });
      if (ev === 'conversation_updated' && !(b.changed_attributes || []).some((c: any) => c && c.status)) return json({ ok: true, ignorado: 'sem mudança de status' });
      const item = await registrar(ev, convId, b.meta?.sender?.phone_number, 'abertura', new Date().toISOString());
      if (!item) return json({ ok: true, ignorado: 'não é de campanha' });
      if (item.ja_atribuida) return json({ ok: true, ignorado: 'já atribuída' });
      const res = await atribuir(convId, item);
      await log(ev, convId, `${item.campanha}: bot passou para humano · ${res}`);
      return json({ ok: true });
    }
    return json({ ok: true, ignorado: ev || 'sem evento' });
  } catch (e) {
    await log(ev, Number(b?.conversation?.id ?? b?.id) || null, 'ERRO: ' + String((e as Error).message || e).slice(0, 250));
    return json({ ok: false }, 200);   // 200 para o CWMKT não ficar reenviando; o erro fica no registro
  }
}

async function usuario(req: Request) {
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: u } = await db.auth.getUser(jwt);
  if (!u?.user) return null;
  const { data: perfil } = await db.from('perfis').select('id,nome,email,papel,ativo').eq('id', u.user.id).maybeSingle();
  return perfil?.ativo ? perfil : null;
}

// ---------- Puxar do CWMKT: conversas abertas/pendentes atribuídas ao cobrador ----------
// O Id do parcelamento vem dos números escritos no nome do contato (ex.: "MARIA 103596 e 103600").
// Nada é gravado aqui: a lista vai para a tela do cobrador, que escolhe o que lançar.
async function conversasDoAgente(agId: number) {
  const out: any[] = [];
  const corpo = { payload: [
    { attribute_key: 'assignee_id', filter_operator: 'equal_to', values: [agId], query_operator: 'and' },
    { attribute_key: 'status', filter_operator: 'equal_to', values: ['open', 'pending'], query_operator: null }
  ] };
  try {
    for (let pg = 1; pg <= 12; pg++) {
      const r = await api(`/conversations/filter?page=${pg}`, { method: 'POST', body: JSON.stringify(corpo) });
      const itens = lista(r?.payload ? r : r?.data);
      out.push(...itens);
      if (itens.length < 25) break;
    }
    return out;
  } catch (_) {
    // CWMKT sem o filtro: percorre as conversas abertas e pendentes e separa as do agente
    for (const st of ['open', 'pending']) for (let pg = 1; pg <= 20; pg++) {
      const r = await api(`/conversations?status=${st}&assignee_type=all&page=${pg}`);
      const itens = lista(r?.data);
      out.push(...itens.filter((c: any) => c?.meta?.assignee?.id === agId));
      if (itens.length < 25) break;
    }
    return out;
  }
}
async function listar(req: Request) {
  const eu = await usuario(req);
  if (!eu) return json({ erro: 'Faça login no sistema.' }, 401, cors);
  if (!BASE || !TOKEN || !CONTA) return json({ erro: 'A ligação com o CWMKT ainda não foi configurada.' }, 200, cors);
  cache = {};
  try {
    const ag = await agenteDe(eu.email, eu.nome);
    if (!ag) return json({ erro: `Não encontrei você (${eu.nome}) entre os agentes do CWMKT.` }, 200, cors);
    const tc = await timeCobranca();
    const convs = (await conversasDoAgente(ag.id)).filter((c: any) => !tc || !c?.meta?.team || c.meta.team.id === tc.id || ehAceito(c.meta.team.name))
      .filter((c: any) => !CAIXA || String(c.inbox_id) === CAIXA);
    const vistos = new Set<number>();
    const conversas = convs.filter((c: any) => !vistos.has(c.id) && vistos.add(c.id)).map((c: any) => {
      const nome = String(c?.meta?.sender?.name || '');
      const ids = [...new Set((nome.match(/(?<!\d)\d{4,8}(?!\d)/g) || []))];
      const ini = Number(c.created_at) || Number(c.timestamp) || 0;
      return { conversa: c.id, contato: nome.slice(0, 120), ids, status: c.status, inicio: ini ? new Date(ini * 1000).toISOString() : null,
               ultima: c.timestamp ? new Date(Number(c.timestamp) * 1000).toISOString() : null, etiquetas: (c.labels || []).slice(0, 6) };
    }).sort((a: any, b: any) => String(b.ultima).localeCompare(String(a.ultima)));
    return json({ agente: ag.name, conversas }, 200, cors);
  } catch (e) { return json({ erro: 'O CWMKT não respondeu: ' + String((e as Error).message || e) }, 200, cors); }
}

async function teste(req: Request, url: URL) {
  const perfil = await usuario(req);
  if (!perfil) return json({ erro: 'Faça login no sistema.' }, 401, cors);
  if (perfil.papel !== 'admin') return json({ erro: 'Somente o administrador.' }, 403, cors);
  await senhaWebhook();
  const falta = [['CWMKT_URL', BASE], ['CWMKT_TOKEN', TOKEN], ['CWMKT_CONTA', CONTA]].filter(x => !x[1]).map(x => x[0]);
  const out: any = { falta, time_nome: TIME, times_aceitos: TIMES_ACEITOS, times_aceitos_encontrados: [], caixa: CAIXA || null, webhook: `${ENV('SUPABASE_URL')}/functions/v1/cwmkt?t=${WEBHOOK_TOKEN}`, cobradores: [], erro_api: null };
  const { data: ev } = await db.from('cwmkt_eventos').select('recebido,evento,conversa,resultado').order('id', { ascending: false }).limit(15);
  out.eventos = ev || [];
  if (falta.length) return json(out, 200, cors);
  try {
    cache = {};
    const tc = await timeCobranca();
    out.time = tc ? { id: tc.id, nome: tc.name } : null;
    out.times = (await times()).map((t: any) => t.name);
    out.times_aceitos_encontrados = out.times.filter((n: string) => ehAceito(n));
    out.tem_etiqueta_campanha = (await etiquetas()).some((l: any) => norm(l.title) === ETIQ_CAMPANHA);
    const { data: ps } = await db.from('perfis').select('id,nome,email,ativo').eq('ativo', true).order('nome');
    for (const p of ps || []) {
      const ag = await agenteDe(p.email, p.nome);
      out.cobradores.push({ nome: p.nome, agente: ag ? ag.name : null, etiqueta: await etiquetaDe(p.nome) });
    }
  } catch (e) { out.erro_api = String((e as Error).message || e); }
  return json(out, 200, cors);
}

Deno.serve(async req => {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ ok: false }, 405);
  if (url.searchParams.get('acao') === 'teste') return teste(req, url);
  if (url.searchParams.get('acao') === 'listar') return listar(req);
  return webhook(req, url);
});
