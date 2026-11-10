// Cobranças PMO – ligação com o CWMKT (WhatsApp da Prefeitura).
// Desde 06/11/2026 o disparo em massa é feito por outro sistema. A função:
// 1) Recebe os avisos (webhook) do CWMKT e reconhece o INÍCIO de um atendimento de campanha:
//    - a mensagem do contribuinte começa por uma frase "contribuinte" (o botão que ele apertou:
//      "Pagar Agora com desconto!", "Quero Parcelar!") — vale também em conversa antiga reaproveitada
//      pelo CWMKT (09/11/2026); conta um atendimento por conversa POR DIA, ou
//    - o atendente manda uma mensagem que começa por uma frase "atendente" ("Prezado Contribuinte: Tributo:").
//    As frases ficam na tabela atendimento_frases (Administração). Grava a conversa em atendimentos_wa,
//    com o PRIMEIRO agente atribuído, e põe a etiqueta "campanha" nas conversas dos botões.
//    Não cria lançamento nem atribui conversa a ninguém. Não guarda telefone nem conteúdo de mensagem.
//    Também conta, por conversa e dia, as mensagens recebidas e enviadas de TODO o CWMKT (cwmkt_conversas_dia, 09/11/2026),
//    para comparar com a campanha em massa, e para qual TIME cada conversa foi encaminhada (cwmkt_times_dia, 10/11/2026).
// 2) Importação (administrador logado no sistema): traz as conversas anteriores, a partir de uma data.
// 3) Modo teste (administrador) e "Puxar do CWMKT" (lista as conversas abertas do cobrador).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const ENV = (k: string) => (Deno.env.get(k) || '').trim();
const BASE = ENV('CWMKT_URL').replace(/\/+$/, '');          // ex.: https://app.cwmkt.cloud
const TOKEN = ENV('CWMKT_TOKEN');                           // token de acesso de um administrador do CWMKT
const CONTA = ENV('CWMKT_CONTA');                           // nº da conta (aparece no endereço: /app/accounts/N/...)
const TIME = ENV('CWMKT_TIME') || 'cobrança manual';         // time dos cobradores (usado no "Puxar do CWMKT")
const CAIXA = ENV('CWMKT_CAIXA');                           // opcional: nº da caixa "Tributário Oficial"
const TIMES_ACEITOS = ENV('CWMKT_TIMES_ACEITOS').split(/[,;]/).map(t => t.trim()).filter(Boolean);
// senha que vai no endereço do webhook: a definida em CWMKT_WEBHOOK_TOKEN ou, se não houver, uma derivada da chave do projeto
let WEBHOOK_TOKEN = ENV('CWMKT_WEBHOOK_TOKEN');
const SEGREDO = ENV('CWMKT_SEGREDO');                       // opcional: segredo de assinatura do webhook
const ETIQ_CAMPANHA = 'campanha';
const SITE = 'https://cobrancas-pmo.github.io';

const db = createClient(ENV('SUPABASE_URL'), ENV('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const cors = { 'Access-Control-Allow-Origin': SITE, 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...extra } });
const iso = (t: unknown) => { const n = Number(t); const d = Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date(String(t)); return isNaN(+d) ? new Date().toISOString() : d.toISOString(); };
const linkDe = (conv: number) => `${BASE}/app/accounts/${CONTA}/conversations/${conv}`;

async function sha256(t: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
}

// ---------- API do CWMKT ----------
async function api1(path: string, init: RequestInit = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(`${BASE}/api/v1/accounts/${CONTA}${path}`, {
      ...init, signal: ctl.signal,
      headers: { 'api_access_token': TOKEN, 'Content-Type': 'application/json', ...(init.headers || {}) }
    });
    const txt = await r.text();
    let body: any = null; try { body = txt ? JSON.parse(txt) : null; } catch { body = txt; }
    if (!r.ok) throw Object.assign(new Error(`CWMKT ${init.method || 'GET'} ${path} → ${r.status}`), { status: r.status });
    return body;
  } finally { clearTimeout(t); }
}
// consultas (GET) que falham por demora ou excesso de pedidos são tentadas mais uma vez
async function api(path: string, init: RequestInit = {}) {
  try { return await api1(path, init); }
  catch (e: any) {
    const ler = !init.method || init.method === 'GET' || path.startsWith('/conversations/filter');
    if (!ler || !(e?.name === 'AbortError' || [429, 500, 502, 503, 504].includes(Number(e?.status)))) throw e;
    await new Promise(r => setTimeout(r, 1500));
    return await api1(path, init);
  }
}
// dia (AAAA-MM-DD) no horário de Brasília
const diaSP = (t: string) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const lista = (b: any) => (Array.isArray(b) ? b : Array.isArray(b?.payload) ? b.payload : []);
type Frase = { frase: string; gatilho: string; quem: string; n: string };
let cache: { agentes?: any[]; times?: any[]; etiquetas?: any[]; frases?: Frase[] } = {};
async function agentes() { return cache.agentes ??= lista(await api('/agents')); }
async function times() { return cache.times ??= lista(await api('/teams')); }
// time do CWMKT para o qual a conversa foi encaminhada, a partir da anotação ("Atribuído a refis 2026 por …")
async function timeDaAtividade(texto: unknown) {
  const t = String(texto || '').trim();
  const x = t.match(/^Atribu[ií]d[oa] (?:[àa] equipe |ao time |a )(.+?) por .+$/i) || t.match(/^Assigned to (?:team )?(.+?) by .+$/i);
  if (!x) return null;
  const n = norm(x[1]);
  return (await times()).find((tm: any) => norm(tm.name) === n)?.name || null;
}
async function etiquetas() { return cache.etiquetas ??= lista(await api('/labels')); }
async function frases(): Promise<Frase[]> {
  if (!cache.frases) {
    const { data } = await db.from('atendimento_frases').select('frase,gatilho,quem').eq('ativo', true);
    cache.frases = (data || []).map((f: any) => ({ ...f, n: norm(f.frase) })).filter((f: Frase) => f.n);
  }
  return cache.frases;
}
// o CWMKT põe o nome do contato na frente da mensagem ("*Maria:* Quero Parcelar!"): tira antes de comparar
const semPrefixo = (t: unknown) => String(t ?? '').replace(/^\s*\*[^*\n]{1,80}:\*\s*/, '');
async function casa(texto: unknown, quem: 'contribuinte' | 'atendente') {
  const n = norm(semPrefixo(texto)); if (!n) return null;
  return (await frases()).find(f => f.quem === quem && n.startsWith(f.n)) || null;
}

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
const ehAceito = (nome: unknown) => { const n = norm(nome); return !!n && TIMES_ACEITOS.some(t => { const a = norm(t); return !!a && (n.includes(a) || a.includes(n)); }); };
async function timeCobranca() { const n = norm(TIME); return (await times()).find(t => norm(t.name) === n) || null; }
async function garantirEtiquetaCampanha() {
  const ets = await etiquetas();
  if (ets.some(l => norm(l.title) === ETIQ_CAMPANHA)) return;
  try { await api('/labels', { method: 'POST', body: JSON.stringify({ title: ETIQ_CAMPANHA, description: 'Atendimento que começou pelo botão da campanha (Sistema de Cobranças)', color: '#7A4FB5', show_on_sidebar: true }) }); cache.etiquetas = undefined; } catch { /* sem permissão: segue sem criar */ }
}
async function addEtiquetas(conv: number, novas: string[]) {
  const atuais: string[] = lista(await api(`/conversations/${conv}/labels`)).map(String);
  const todas = [...new Set([...atuais, ...novas.filter(Boolean)])];
  if (todas.length !== atuais.length) await api(`/conversations/${conv}/labels`, { method: 'POST', body: JSON.stringify({ labels: todas }) });
}
async function etiquetar(conv: number) {
  try { await garantirEtiquetaCampanha(); await addEtiquetas(conv, [ETIQ_CAMPANHA]); return true; } catch { return false; }
}
// agente do CWMKT pelo id (com nome e e-mail da lista de agentes)
async function agentePorId(id: unknown, reserva: any = null) {
  const n = Number(id); if (!n) return null;
  const a = (await agentes().catch(() => [])).find((x: any) => Number(x?.id) === n);
  const nome = String(a?.name || a?.available_name || reserva?.available_name || reserva?.name || '').trim();
  return nome ? { id: n, nome: nome.slice(0, 120), email: (a?.email || reserva?.email || null) } : null;
}
// todas as mensagens da conversa, da mais antiga para a mais nova (até 160)
// (com desdeSeg, para de voltar quando já chegou em mensagens anteriores a essa hora)
async function mensagens(conv: number, desdeSeg = 0) {
  let msgs: any[] = []; let antes = '';
  for (let i = 0; i < 8; i++) {
    const p = lista(await api(`/conversations/${conv}/messages${antes}`));
    msgs = [...p, ...msgs];
    if (p.length < 20) break;
    if (desdeSeg && Math.min(...p.map((m: any) => Number(m.created_at) || Infinity)) < desdeSeg) break;
    antes = `?before=${Math.min(...p.map((m: any) => Number(m.id)))}`;
  }
  return msgs.sort((a, b) => Number(a.id) - Number(b.id));
}
const tipoMsg = (m: any) => String(m?.message_type);                 // 0/incoming, 1/outgoing, 2/activity, 3/template
const entrada = (m: any) => ['0', 'incoming'].includes(tipoMsg(m));
const ativ = (m: any) => tipoMsg(m) === '2' || tipoMsg(m) === 'activity';
const ehHumano = (s: any) => /^user$/i.test(String(s?.type || ''));
const saidaHumana = (m: any) => ['1', 'outgoing', '3', 'template'].includes(tipoMsg(m)) && ehHumano(m?.sender || { type: m?.sender_type });

// ---------- atendimentos ----------
// um atendimento por conversa POR DIA (o CWMKT reaproveita a conversa antiga do contribuinte)
async function atendimento(conv: number, dia: string) {
  const { data, error } = await db.from('atendimentos_wa').select('conversa,dia,gatilho,agente_id,agente_nome').eq('conversa', conv).eq('dia', dia).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}
async function abrir(row: Record<string, unknown>) {
  const { error } = await db.from('atendimentos_wa').insert(row);
  if (error && !/duplicate|unique/i.test(error.message)) throw new Error(error.message);
  return !error;
}
async function definirAgente(conv: number, dia: string, ag: { id: number | null; nome: string; email: string | null }, quando: string) {
  const { data } = await db.from('atendimentos_wa')
    .update({ agente_id: ag.id, agente_nome: ag.nome, agente_email: ag.email, atribuido_em: quando })
    .eq('conversa', conv).eq('dia', dia).is('agente_id', null).is('agente_nome', null).select('conversa');
  return !!data?.length;
}
const log = (evento: string, conv: number | null, resultado: string) => db.rpc('cwmkt_log', { p_evento: evento, p_conversa: conv, p_resultado: resultado.slice(0, 300) });

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
      if (!convId) return json({ ok: true, ignorado: 'sem conversa' });
      const caixa = String(b.inbox?.id ?? conv.inbox_id ?? '');
      // DIAGNÓSTICO: anota por que uma mensagem com cara de botão de campanha (começa por "pagar agora", "quero parcelar" ou
      // "não reconheço a cobrança") foi descartada — só nesses casos, para não guardar texto de mensagem comum
      const tx = norm(semPrefixo(b.content));
      const botao = /^(pagar agora|quero parcelar|nao reconheco a cobranca)/.test(tx);
      const diag = async (motivo: string) => {
        if (!botao) return;
        await log('diag', convId, `${motivo} · caixa ${caixa || '?'} · tipo ${tipoMsg(b)} · texto [${tx.replace(/\d/g, '#').slice(0, 40)}]`);
      };
      if (CAIXA && caixa !== CAIXA) { await diag('outra caixa'); return json({ ok: true, ignorado: 'outra caixa' }); }
      if (b.private) return json({ ok: true, ignorado: 'nota interna' });
      const quando = iso(b.created_at);
      // totais do CWMKT (campanha ou não): soma 1 mensagem recebida/enviada na conversa e no dia — só números
      if (!ativ(b) && (entrada(b) || ['1', 'outgoing', '3', 'template'].includes(tipoMsg(b))))
        await db.rpc('cwmkt_contar', { p_conversa: convId, p_quando: quando, p_caixa: Number(caixa) || null, p_entrada: entrada(b) });
      // encaminhada para um time (anotação do CWMKT): registra conversa/dia/time
      if (ativ(b)) {
        const tm = await timeDaAtividade(b.content);
        if (tm) { await db.rpc('cwmkt_time', { p_conversa: convId, p_quando: quando, p_time: tm }); return json({ ok: true, time: tm }); }
        return json({ ok: true, ignorado: 'anotação' });
      }
      const dia = diaSP(quando);
      // conversa aberta hoje (nova) ou reaproveitada de outro dia: na reaproveitada, o agente que já estava
      // atribuído é do atendimento antigo e não conta
      const nova = conv.created_at ? diaSP(iso(conv.created_at)) === dia : false;
      const at = await atendimento(convId, dia);
      if (entrada(b)) {
        if (at) { await diag('atendimento já aberto hoje'); return json({ ok: true, ignorado: 'atendimento já aberto hoje' }); }
        const f = await casa(b.content, 'contribuinte');
        if (!f) { await diag(`não casou frase (${(await frases()).length} frases)`); return json({ ok: true, ignorado: 'não começa por frase de campanha' }); }
        if (!(await abrir({ conversa: convId, gatilho: f.gatilho, iniciada_em: quando, caixa: Number(caixa) || null, origem: 'aviso', link: linkDe(convId) })))
          return json({ ok: true, ignorado: 'já aberto' });
        const ass = conv.meta?.assignee;
        const ag = nova && ass?.id ? await agentePorId(ass.id, ass) : null;
        if (ag) await definirAgente(convId, dia, ag, quando);
        const et = await etiquetar(convId);
        if (et) await db.from('atendimentos_wa').update({ etiqueta: true }).eq('conversa', convId).eq('dia', dia);
        await log(ev, convId, `${f.gatilho}: atendimento aberto${nova ? '' : ' (conversa reaproveitada)'}${ag ? ' · 1º atendente ' + ag.nome : ''}${et ? ' · etiqueta campanha' : ' · SEM etiqueta'}`);
        return json({ ok: true });
      }
      if (saidaHumana(b)) {
        const ag = await agentePorId(b.sender?.id, b.sender);
        if (!at) {
          const f = await casa(b.content, 'atendente');
          if (!f) return json({ ok: true, ignorado: 'mensagem comum' });
          if (await abrir({ conversa: convId, gatilho: f.gatilho, iniciada_em: quando, caixa: Number(caixa) || null, origem: 'aviso', link: linkDe(convId),
                            agente_id: ag?.id ?? null, agente_nome: ag?.nome ?? null, agente_email: ag?.email ?? null, atribuido_em: ag ? quando : null }))
            await log(ev, convId, `${f.gatilho}: atendimento aberto por ${ag?.nome || 'agente'}`);
          return json({ ok: true });
        }
        if (at.agente_id == null && !at.agente_nome) {
          // ainda sem atendente: vale o agente atribuído à conversa; se não houver (ou se for de outro
          // atendimento, numa conversa reaproveitada), quem respondeu
          let quem = null;
          try {
            const c = await api(`/conversations/${convId}`); const a = c?.meta?.assignee;
            if (a?.id && (nova || Number(a.id) === Number(ag?.id))) quem = await agentePorId(a.id, a);
          } catch { /* segue com quem respondeu */ }
          quem ??= ag;
          if (quem && await definirAgente(convId, dia, quem, quando)) await log(ev, convId, `${at.gatilho}: 1º atendente ${quem.nome}`);
        }
        return json({ ok: true });
      }
      await diag(`não é entrada nem saída humana (sender ${b.sender?.type ?? '?'})`);
      return json({ ok: true, ignorado: 'mensagem do bot ou do sistema' });
    }
    if (ev === 'conversation_updated' || ev === 'conversation_status_changed' || ev === 'assignee_changed') {
      const convId = Number(b.id) || null;
      if (!convId) return json({ ok: true, ignorado: 'sem conversa' });
      const dia = diaSP(new Date().toISOString());
      // mudou o time da conversa: registra conversa/dia/time (o mesmo que a anotação "Atribuído a <time>")
      const chs = Array.isArray(b.changed_attributes) ? b.changed_attributes : b.changed_attributes ? [b.changed_attributes] : [];
      const mt = chs.find((x: any) => x && typeof x === 'object' && 'team_id' in x)?.team_id;
      const novoTime = mt && (mt.current_value ?? mt[1]);
      if (novoTime) {
        const nome = b.meta?.team?.name || (await times().catch(() => [])).find((tm: any) => Number(tm.id) === Number(novoTime))?.name;
        if (nome) await db.rpc('cwmkt_time', { p_conversa: convId, p_quando: new Date().toISOString(), p_time: nome });
      }
      const at = await atendimento(convId, dia);
      if (!at || at.agente_id != null || at.agente_nome) return json({ ok: true, ignorado: 'nada a fazer' });
      const a = b.meta?.assignee;
      if (!a?.id) return json({ ok: true, ignorado: 'sem agente' });
      // numa conversa reaproveitada, só vale se a atribuição mudou agora (senão é o agente de outro dia)
      const ch = b.changed_attributes;
      const mudou = ev === 'assignee_changed' || (Array.isArray(ch) ? ch.some((x: any) => x && typeof x === 'object' && 'assignee_id' in x)
                                                  : !!(ch && typeof ch === 'object' && 'assignee_id' in ch));
      const nova = b.created_at ? diaSP(iso(b.created_at)) === dia : false;
      if (!mudou && !nova) return json({ ok: true, ignorado: 'agente de antes' });
      const ag = await agentePorId(a.id, a);
      if (ag && await definirAgente(convId, dia, ag, new Date().toISOString())) await log(ev, convId, `${at.gatilho}: 1º atendente ${ag.nome}`);
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

// ---------- Importação: conversas anteriores (só administrador) ----------
// etapa=lista&desde=AAAA-MM-DD&pg=N → ids das conversas com MOVIMENTO desde a data (até 40 páginas por chamada).
//   Não basta "criadas desde a data": o CWMKT reaproveita a conversa antiga do contribuinte quando ele aperta o botão.
// etapa=conversas&desde=AAAA-MM-DD&ids=1,2,3 → em cada conversa, a partir da data, acha por dia a 1ª mensagem
//   que começa por uma frase e grava um atendimento por dia (sem repetir os que já existem)
async function importar(req: Request, url: URL) {
  const perfil = await usuario(req);
  if (!perfil) return json({ erro: 'Faça login no sistema.' }, 401, cors);
  if (perfil.papel !== 'admin') return json({ erro: 'Somente o administrador.' }, 403, cors);
  if (!BASE || !TOKEN || !CONTA) return json({ erro: 'A ligação com o CWMKT ainda não foi configurada.' }, 200, cors);
  cache = {};
  const desde = String(url.searchParams.get('desde') || '');
  if (!/^\d{4}-\d\d-\d\d$/.test(desde)) return json({ erro: 'Data inválida.' }, 200, cors);
  const limite = new Date(desde + 'T00:00:00-03:00').getTime() / 1000;
  try {
    if (url.searchParams.get('etapa') === 'lista') {
      const d = new Date(desde + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);   // o filtro do CWMKT é "depois de"
      const filtro = (campo: string) => ({ payload: [{ attribute_key: campo, filter_operator: 'is_greater_than', values: [d.toISOString().slice(0, 10)], query_operator: null }] });
      const ini = Math.max(1, Number(url.searchParams.get('pg')) || 1); const ids: number[] = []; let proxima: number | null = null;
      let campo = 'last_activity_at';
      for (let p = ini; p < ini + 40; p++) {
        let r: any;
        try { r = await api(`/conversations/filter?page=${p}`, { method: 'POST', body: JSON.stringify(filtro(campo)) }); }
        catch (e) { if (campo === 'created_at' || p !== ini) throw e; campo = 'created_at'; p--; continue; }   // CWMKT sem esse filtro
        const itens = lista(r?.payload ? r : r?.data);
        ids.push(...itens.filter((c: any) => (!CAIXA || String(c.inbox_id) === CAIXA)
          && Number(campo === 'created_at' ? c.created_at : (c.last_activity_at || c.timestamp || c.created_at)) >= limite).map((c: any) => Number(c.id)));
        if (itens.length < 25) { proxima = null; break; }
        proxima = p + 1;
      }
      return json({ ids: [...new Set(ids)], proxima }, 200, cors);
    }
    const ids = [...new Set(String(url.searchParams.get('ids') || '').split(',').map(Number).filter(Boolean))].slice(0, 25);
    const nomesTimes = new Set((await times()).map((t: any) => norm(t.name)));
    const ags = await agentes();
    const res = { novos: 0, ja: 0, outros: 0, erros: 0 };
    for (const conv of ids) {
      try {
        const msgs = await mensagens(conv, limite);
        const quandoDe = (m: any) => iso(m.created_at);
        // totais do CWMKT por dia nesta conversa (recebidas do contribuinte e enviadas pela Prefeitura)
        const tot = new Map<string, { r: number; e: number; cx: number | null }>();
        for (const m of msgs) {
          if (m.private || ativ(m) || Number(m.created_at) < limite) continue;
          const ent = entrada(m); if (!ent && !['1', 'outgoing', '3', 'template'].includes(tipoMsg(m))) continue;
          const d = diaSP(quandoDe(m)); const t = tot.get(d) || { r: 0, e: 0, cx: Number(m.inbox_id) || null };
          if (ent) t.r++; else t.e++; tot.set(d, t);
        }
        for (const [d, t] of tot) await db.rpc('cwmkt_contar_dia', { p_conversa: conv, p_dia: d, p_caixa: t.cx, p_recebidas: t.r, p_enviadas: t.e });
        // times para os quais a conversa foi encaminhada (anotações "Atribuído a <time> por …")
        for (const m of msgs) {
          if (!ativ(m) || Number(m.created_at) < limite) continue;
          const tm = await timeDaAtividade(m.content);
          if (tm) await db.rpc('cwmkt_time', { p_conversa: conv, p_quando: quandoDe(m), p_time: tm });
        }
        // por dia, a 1ª mensagem (do contribuinte ou do atendente) que começa por uma frase
        const inicios = new Map<string, { m: any; f: Frase }>();
        for (const m of msgs) {
          if (m.private || ativ(m) || Number(m.created_at) < limite) continue;
          const f = entrada(m) ? await casa(m.content, 'contribuinte') : saidaHumana(m) ? await casa(m.content, 'atendente') : null;
          if (!f) continue;
          const dia = diaSP(quandoDe(m));
          if (!inicios.has(dia)) inicios.set(dia, { m, f });
        }
        if (!inicios.size) { res.outros++; continue; }
        let etiq = false;
        for (const [dia, { m: m0, f }] of inicios) {
          if (await atendimento(conv, dia)) { res.ja++; if (f.quem === 'contribuinte') etiq = true; continue; }
          let quem: any = null; let atrib: string | null = null;
          const depois = (m: any) => Number(m.id) > Number(m0.id) && diaSP(quandoDe(m)) === dia;
          if (f.quem === 'atendente') { quem = await agentePorId(m0.sender?.id, m0.sender); atrib = quandoDe(m0); }
          else {
            // 1º agente atribuído depois do clique: pelas anotações do CWMKT ("Atribuído a X por Y", "X atribuiu a si mesmo essa conversa")
            for (const m of msgs) {
              if (!ativ(m) || !depois(m)) continue;
              const t = String(m.content || '').trim();
              let x = t.match(/^Atribuído a (.+?) por .+$/i) || t.match(/^Assigned to (.+?) by .+$/i);
              let nome = x && !nomesTimes.has(norm(x[1])) ? x[1] : null;
              if (!nome) { x = t.match(/^(.+?) atribuiu a si mesm[oa] (essa|esta) conversa/i) || t.match(/^(.+?) self-assigned this conversation/i); nome = x ? x[1] : null; }
              if (nome) { const a = ags.find((g: any) => norm(g.name) === norm(nome)); quem = a ? await agentePorId(a.id, a) : { id: null, nome: nome.trim().slice(0, 120), email: null }; atrib = quandoDe(m); break; }
            }
            // sem anotação: o 1º atendente que respondeu depois do clique
            if (!quem) { const r = msgs.find(m => !m.private && depois(m) && saidaHumana(m)); if (r) { quem = await agentePorId(r.sender?.id, r.sender); atrib = quandoDe(r); } }
          }
          const ok = await abrir({ conversa: conv, gatilho: f.gatilho, iniciada_em: quandoDe(m0), caixa: null, origem: 'importacao', link: linkDe(conv),
            agente_id: quem?.id ?? null, agente_nome: quem?.nome ?? null, agente_email: quem?.email ?? null, atribuido_em: quem ? atrib : null });
          if (!ok) { res.ja++; continue; }
          res.novos++;
          if (f.quem === 'contribuinte') etiq = true;
        }
        if (etiq && await etiquetar(conv)) await db.from('atendimentos_wa').update({ etiqueta: true }).eq('conversa', conv).gte('iniciada_em', new Date(limite * 1000).toISOString());
      } catch (_) { res.erros++; }
    }
    if (res.novos) await log('importacao', null, `${perfil.nome}: ${res.novos} atendimento(s) trazido(s) do CWMKT`);
    return json(res, 200, cors);
  } catch (e) { return json({ erro: 'O CWMKT não respondeu: ' + String((e as Error).message || e) }, 200, cors); }
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

async function teste(req: Request) {
  const perfil = await usuario(req);
  if (!perfil) return json({ erro: 'Faça login no sistema.' }, 401, cors);
  if (perfil.papel !== 'admin') return json({ erro: 'Somente o administrador.' }, 403, cors);
  await senhaWebhook();
  cache = {};
  const falta = [['CWMKT_URL', BASE], ['CWMKT_TOKEN', TOKEN], ['CWMKT_CONTA', CONTA]].filter(x => !x[1]).map(x => x[0]);
  const out: any = { falta, caixa: CAIXA || null, webhook: `${ENV('SUPABASE_URL')}/functions/v1/cwmkt?t=${WEBHOOK_TOKEN}`, erro_api: null };
  const { data: ev } = await db.from('cwmkt_eventos').select('recebido,evento,conversa,resultado').order('id', { ascending: false }).limit(15);
  out.eventos = ev || [];
  out.frases = (await frases()).length;
  const { count } = await db.from('atendimentos_wa').select('conversa', { count: 'exact', head: true });
  out.atendimentos = count || 0;
  if (falta.length) return json(out, 200, cors);
  try {
    out.agentes = (await agentes()).length;
    out.tem_etiqueta_campanha = (await etiquetas()).some((l: any) => norm(l.title) === ETIQ_CAMPANHA);
  } catch (e) { out.erro_api = String((e as Error).message || e); }
  return json(out, 200, cors);
}

Deno.serve(async req => {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ ok: false }, 405);
  const acao = url.searchParams.get('acao');
  if (acao === 'importar') return importar(req, url);
  if (acao === 'teste') return teste(req);
  if (acao === 'listar') return listar(req);
  return webhook(req, url);
});
