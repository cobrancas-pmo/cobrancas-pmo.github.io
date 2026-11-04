/* Cobranças PMO – Campanhas: leitura dos arquivos do SMAR e montagem da planilha da Assertiva.
   Tudo acontece no navegador. Nome, CPF, telefone e e-mail NÃO são enviados ao banco:
   saem daqui só o Id do parcelamento, setor, origem, tipo de cobrança e o telefone embaralhado. */
(function (root) {
  'use strict';
  const DDD_PADRAO = '14';                 // Ourinhos: completa números sem DDD
  const SAL_HASH = 'cobrancas-pmo|';       // mesmo prefixo será usado na ligação com o CWMKT
  const RE_ID = /^[0-9A-Za-z./-]{1,30}$/;

  const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // nomes de coluna aceitos (comparados sem acento, maiúsculas, espaços ou pontuação)
  const COLS = {
    id: ['parcelamento', 'idparcelamento', 'identificacaodivida'],
    nome: ['nome', 'contribuinte', 'nomecontribuinte'],
    venc: ['datavencimento', 'vencimento'],
    qtdVenc: ['quantidadevencidas', 'qtdvencidas', 'parcelasvencidas'],
    valor: ['valoraberto', 'valor', 'valoremaberto'],
    crc: ['crc', 'codigocontribuinte'],
    origem: ['origem', 'inscricao'],
    setor: ['setororigem', 'setor'],
    tel: ['telefone', 'telefones', 'celular', 'fone'],
    situacao: ['situacao'],
    diasAtraso: ['quantidadediasatraso', 'diasatraso', 'diasdeatraso'],
    doc: ['cpfcnpj', 'cpf', 'cnpj', 'documento', 'cpfoucnpj', 'cnpjcpf'],
    email: ['email', 'emails', 'enderecoemail']
  };
  const SETORES = { imobiliario: 'Imobiliário', mobiliario: 'Mobiliário', contribuinte: 'CRC', crc: 'CRC', uc: 'UC' };

  // ---------- leitura ----------
  function lerArquivo(buf, XLSX) {
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const m = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
    // a linha de títulos é a primeira que tem pelo menos 2 colunas conhecidas (o SMAR põe um título antes)
    const conhecidas = new Set(Object.values(COLS).flat());
    let hi = -1;
    for (let i = 0; i < Math.min(m.length, 30); i++) {
      if ((m[i] || []).filter(c => conhecidas.has(norm(c))).length >= 2) { hi = i; break; }
    }
    if (hi < 0) throw new Error('Não encontrei a linha de títulos (Parcelamento, Nome, Valor Aberto…) no arquivo.');
    const cab = m[hi].map(c => String(c ?? '').trim());
    const idx = {};
    for (const [k, nomes] of Object.entries(COLS)) {
      const i = cab.findIndex(c => nomes.includes(norm(c)));
      if (i >= 0) idx[k] = i;
    }
    return { cab, idx, linhas: m.slice(hi + 1), nomePlanilha: wb.SheetNames[0] };
  }

  // ---------- normalizações ----------
  const txt = v => (v == null ? '' : v instanceof Date ? v.toISOString() : String(v)).trim();
  function numero(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Math.round(v * 100) / 100;
    let s = String(v).replace(/[R$\s]/g, '');
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = Number(s); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  }
  function data(v) {   // devolve AAAA-MM-DD
    if (v == null || v === '') return null;
    if (v instanceof Date && !isNaN(v)) {
      // datas do Excel chegam à meia-noite local; soma 12h para não cair no dia anterior
      const d = new Date(v.getTime() + 12 * 3600e3); return d.toISOString().slice(0, 10);
    }
    if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10);
    const m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const m2 = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m2 ? `${m2[1]}-${m2[2]}-${m2[3]}` : null;
  }
  const dataBR = iso => (iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '');

  // telefones: separa os números, completa o DDD, corrige celular antigo sem o 9 e escolhe o 1º celular
  function telefones(v) {
    const out = [];
    for (const parte of txt(v).split(/[\/;,|]| e | ou /i)) {
      let d = parte.replace(/\D/g, '');
      if (!d) continue;
      if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
      if (d.length === 11 && d.startsWith('0')) d = d.slice(1);           // 014 3322-1100
      if (d.length === 12 && d.startsWith('0')) d = d.slice(1);           // 014 99999-9999
      if (d.length === 8 || (d.length === 9 && d[0] === '9')) d = DDD_PADRAO + d;
      if (d.length === 10 && '6789'.includes(d[2])) d = d.slice(0, 2) + '9' + d.slice(2);   // celular sem o 9
      if (d.length === 11 && d[2] === '9' && d[0] !== '0') out.push({ num: d, cel: true });
      else if (d.length === 10 && '2345'.includes(d[2]) && d[0] !== '0') out.push({ num: d, cel: false });
    }
    return out;
  }
  function cpfValido(c) {
    if (!/^\d{11}$/.test(c) || /^(\d)\1+$/.test(c)) return false;
    for (const t of [9, 10]) {
      let s = 0; for (let i = 0; i < t; i++) s += Number(c[i]) * (t + 1 - i);
      if (((s * 10) % 11) % 10 !== Number(c[t])) return false;
    }
    return true;
  }
  function cnpjValido(c) {
    if (!/^\d{14}$/.test(c) || /^(\d)\1+$/.test(c)) return false;
    const calc = n => { let s = 0, p = n - 7; for (let i = 0; i < n; i++) { s += Number(c[i]) * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
    return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
  }
  function documento(v) {   // CPF/CNPJ só com números, com os zeros à esquerda de volta
    let d = (typeof v === 'number' ? String(Math.round(v)) : txt(v)).replace(/\D/g, '');
    if (!d) return { doc: null, valido: false, vazio: true };
    if (d.length <= 11) d = d.padStart(11, '0'); else if (d.length <= 14) d = d.padStart(14, '0');
    const valido = d.length === 11 ? cpfValido(d) : d.length === 14 ? cnpjValido(d) : false;
    return { doc: valido ? d : null, valido, vazio: false };
  }
  function email(v) {
    const m = txt(v).toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
    return m ? m[0] : null;
  }
  const setorSistema = v => SETORES[norm(v)] || null;

  // ---------- montagem dos contribuintes ----------
  // arq = lerArquivo(...) principal; extra = segundo arquivo opcional (juntado pelo Crc)
  function montar(arq, extra) {
    const I = arq.idx;
    if (I.id == null || I.nome == null || I.valor == null || I.venc == null) {
      const falta = [['Parcelamento', I.id], ['Nome', I.nome], ['Valor Aberto', I.valor], ['Data Vencimento', I.venc]].filter(x => x[1] == null).map(x => x[0]);
      throw new Error('O arquivo não tem a(s) coluna(s): ' + falta.join(', ') + '.');
    }
    const porCrc = new Map();
    if (extra) {
      const E = extra.idx;
      if (E.crc == null) throw new Error('O segundo arquivo precisa da coluna Crc para ser juntado.');
      for (const l of extra.linhas) {
        const crc = txt(l[E.crc]); if (!crc) continue;
        const d = E.doc != null ? documento(l[E.doc]) : { doc: null };
        const e = E.email != null ? email(l[E.email]) : null;
        const t = E.tel != null ? telefones(l[E.tel]) : [];
        const a = porCrc.get(crc) || {};
        porCrc.set(crc, { doc: a.doc || d.doc, email: a.email || e, tels: (a.tels || []).concat(t) });
      }
    }
    const conf = { lidas: 0, rodape: 0, repetidos: 0, revogados: 0, semDoc: 0, docInvalido: 0, semCel: 0, semEmail: 0, semContato: 0, completadosPeloExtra: 0 };
    const vistos = new Set(); const itens = [];
    for (const l of arq.linhas) {
      const id = txt(l[I.id]).replace(/\.0$/, '');
      if (!RE_ID.test(id) || !txt(l[I.nome])) { if (l.some(c => c != null && c !== '')) conf.rodape++; continue; }
      conf.lidas++;
      if (vistos.has(id)) { conf.repetidos++; continue; }
      vistos.add(id);
      if (I.situacao != null && norm(l[I.situacao]) === 'revogado') { conf.revogados++; continue; }
      const crc = I.crc != null ? txt(l[I.crc]).replace(/\.0$/, '') : '';
      const ex = crc ? porCrc.get(crc) : null;
      let d = I.doc != null ? documento(l[I.doc]) : { doc: null, vazio: true };
      let e = I.email != null ? email(l[I.email]) : null;
      let tels = I.tel != null ? telefones(l[I.tel]) : [];
      if (ex) {
        if (!d.doc && ex.doc) { d = { doc: ex.doc, valido: true }; conf.completadosPeloExtra++; }
        if (!e && ex.email) e = ex.email;
        if (!tels.some(t => t.cel) && ex.tels.length) tels = tels.concat(ex.tels);
      }
      const cel = (tels.find(t => t.cel) || {}).num || null;
      const qv = numero(I.qtdVenc != null ? l[I.qtdVenc] : null);
      const it = {
        id, nome: txt(l[I.nome]).replace(/\s+/g, ' '), crc, doc: d.doc, email: e, cel,
        valor: numero(l[I.valor]), venc: data(l[I.venc]),
        origem: I.origem != null ? txt(l[I.origem]).replace(/\.0$/, '') : '',
        setorSmar: I.setor != null ? txt(l[I.setor]) : '', setor: I.setor != null ? setorSistema(l[I.setor]) : null,
        qtdVenc: qv, tipo: qv == null ? null : qv >= 3 ? 'Padrão' : 'Antecipada',
        diasAtraso: numero(I.diasAtraso != null ? l[I.diasAtraso] : null),
        linha: l
      };
      if (!it.doc) { if (d.vazio) conf.semDoc++; else conf.docInvalido++; }
      if (!it.cel) conf.semCel++;
      if (!it.email) conf.semEmail++;
      if (!it.cel && !it.email) conf.semContato++;
      itens.push(it);
    }
    conf.validos = itens.length;
    return { itens, conf, temDoc: I.doc != null || !!(extra && extra.idx.doc != null), temEmail: I.email != null || !!(extra && extra.idx.email != null) };
  }

  // contribuinte = mesmo CPF/CNPJ; sem CPF, mesmo Crc; sem Crc, mesmo celular ou nome
  const chave = it => it.doc ? 'd' + it.doc : it.crc ? 'c' + it.crc : it.cel ? 't' + it.cel : 'n' + norm(it.nome);
  function agrupar(itens) {
    const g = new Map();
    for (const it of itens) { const k = chave(it); if (!g.has(k)) g.set(k, []); g.get(k).push(it); }
    return [...g.entries()].map(([k, lista]) => ({
      chave: k, itens: lista, nome: lista[0].nome,
      valor: lista.reduce((a, x) => a + (x.valor || 0), 0),
      diasAtraso: Math.max(0, ...lista.map(x => x.diasAtraso || 0)),
      doc: lista.find(x => x.doc)?.doc || null, cel: lista.find(x => x.cel)?.cel || null, email: lista.find(x => x.email)?.email || null
    }));
  }
  const ORDENS = {
    maior: (a, b) => b.valor - a.valor,
    menor: (a, b) => a.valor - b.valor,
    atraso: (a, b) => b.diasAtraso - a.diasAtraso || b.valor - a.valor
  };
  // pode entrar na campanha pelos canais escolhidos?
  function apto(g, canais) {
    if (!g.doc) return false;
    return (canais.includes('SMS') && !!g.cel) || (canais.includes('E-mail') && !!g.email);
  }

  // ---------- divisão em partes de valor parecido ----------
  // maior primeiro, sempre para quem está com o menor total (contribuinte inteiro com um cobrador só)
  function dividir(grupos, cobradores) {
    const partes = cobradores.map(c => ({ ...c, grupos: [], valor: 0, parcelamentos: 0, comCel: 0 }));
    for (const g of grupos.slice().sort(ORDENS.maior)) {
      const p = partes.reduce((a, b) => (b.valor < a.valor || (b.valor === a.valor && b.parcelamentos < a.parcelamentos) ? b : a));
      p.grupos.push(g); p.valor += g.valor; p.parcelamentos += g.itens.length; p.comCel += g.itens.filter(i => i.cel).length;
    }
    return partes;
  }

  // ---------- planilhas ----------
  const ASSERTIVA = ['documento', 'nome', 'identificacaodivida', 'valor', 'vencimento', 'observacoes', 'telefone', 'email',
    'identificacaoparcela', 'quantidadeparcelas', 'recorrente', 'fimrecorrencia', 'marcadores'];
  function planilhaAssertiva(grupos, canais, codigo, XLSX) {
    const sms = canais.includes('SMS'), mail = canais.includes('E-mail');
    const linhas = [ASSERTIVA];
    for (const g of grupos) for (const it of g.itens) {
      const obs = [it.origem && 'Origem ' + it.origem, it.setorSmar].filter(Boolean).join(' - ');
      linhas.push([g.doc, it.nome, it.id, it.valor ?? 0, dataBR(it.venc), obs,
        sms && g.cel ? Number(g.cel) : null, mail && g.email ? g.email : null, 1, 1, 'não', null, codigo]);
    }
    const ws = XLSX.utils.aoa_to_sheet(linhas);
    // CPF/CNPJ como texto (não perde o zero à esquerda) e Id como texto
    for (let r = 1; r < linhas.length; r++) {
      for (const c of [0, 2]) { const a = XLSX.utils.encode_cell({ r, c }); if (ws[a]) { ws[a].t = 's'; ws[a].v = String(ws[a].v); ws[a].z = '@'; } }
      const v = XLSX.utils.encode_cell({ r, c: 3 }); if (ws[v]) ws[v].z = '0.00';
    }
    ws['!cols'] = [16, 34, 14, 11, 12, 30, 14, 30, 8, 8, 9, 10, 22].map(w => ({ wch: w }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'modelo_incluir_divida');
    return wb;
  }
  // lista de um cobrador no mesmo formato do arquivo do SMAR (+ colunas para completar CPF/CNPJ e e-mail)
  function planilhaLista(arq, grupos, ordem, XLSX) {
    const cab = arq.cab.slice();
    const add = [];
    if (arq.idx.doc == null) { cab.push('CPF/CNPJ'); add.push(''); }
    if (arq.idx.email == null) { cab.push('E-mail'); add.push(''); }
    const rows = [cab];
    for (const g of grupos.slice().sort(ORDENS[ordem] || ORDENS.maior)) for (const it of g.itens) rows.push(it.linha.slice(0, arq.cab.length).concat(add));
    const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true, dateNF: 'dd/mm/yyyy' });
    const iDoc = arq.idx.doc != null ? arq.idx.doc : arq.cab.length;
    for (let r = 1; r < rows.length; r++) { const a = XLSX.utils.encode_cell({ r, c: iDoc }); ws[a] = ws[a] || { t: 's', v: '' }; ws[a].z = '@'; }
    ws['!cols'] = cab.map(c => ({ wch: Math.max(10, Math.min(36, c.length + 4)) }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, (arq.nomePlanilha || 'Lista').slice(0, 31));
    return wb;
  }

  async function hashTelefone(cel) {
    if (!cel) return null;
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SAL_HASH + '55' + cel));
    return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
  }
  const fmtTel = c => (c ? `(${c.slice(0, 2)}) ${c.slice(2, c.length - 4)}-${c.slice(-4)}` : '');

  root.Campanhas = { lerArquivo, montar, agrupar, apto, dividir, ORDENS, planilhaAssertiva, planilhaLista, hashTelefone, fmtTel, dataBR,
    _t: { telefones, documento, email, numero, data, cpfValido, cnpjValido } };
})(typeof window !== 'undefined' ? window : globalThis);
