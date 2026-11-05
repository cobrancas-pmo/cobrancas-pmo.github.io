-- =====================================================================
-- COBRANÇAS PMO – Campanha: lançamento só quando agente cadastrado atende (05/11/2026)
-- Antes: registrar a campanha criava na hora os lançamentos no Lançar de quem enviou.
-- Agora: registrar só guarda os itens (com setor, origem e tipo de cobrança). O lançamento
-- nasce quando um agente CADASTRADO no sistema responde no WhatsApp (CWMKT) — para quem
-- respondeu primeiro, com a data dessa resposta. Se quem respondeu não é cadastrado, fica
-- anotado só o nome dele (atendente_nome) para consulta em "Ver casos".
-- =====================================================================
alter table public.campanha_itens add column if not exists setor text;
alter table public.campanha_itens add column if not exists origem text;
alter table public.campanha_itens add column if not exists tipo_cobranca text;
alter table public.campanha_itens add column if not exists atendente_nome text;          -- nome do agente no CWMKT
alter table public.campanha_itens add column if not exists atendido_por uuid references public.perfis(id) on delete set null; -- se cadastrado
alter table public.campanha_itens add column if not exists atendido_em timestamptz;

-- texto sem acento, minúsculo e com espaços simples (para comparar nomes)
create or replace function privado.norm_nome(t text) returns text
language sql immutable set search_path to '' as $$
  select btrim(regexp_replace(lower(translate(coalesce(t, ''),
    'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç', 'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc')), '\s+', ' ', 'g'))
$$;

-- acha o usuário ativo do sistema que corresponde ao agente do CWMKT:
-- e-mail igual → nome completo igual → primeiro + último nome iguais → primeiro nome (se único)
create or replace function privado.perfil_do_agente(p_email text, p_nome text) returns uuid
language plpgsql stable set search_path to '' as $$
declare v uuid; n text := privado.norm_nome(p_nome); w text[]; c int;
begin
  if nullif(btrim(coalesce(p_email, '')), '') is not null then
    select id into v from public.perfis where ativo and lower(email) = lower(btrim(p_email)) limit 1;
    if v is not null then return v; end if;
  end if;
  if n = '' then return null; end if;
  select id into v from public.perfis where ativo and privado.norm_nome(nome) = n limit 1;
  if v is not null then return v; end if;
  w := string_to_array(n, ' ');
  if array_length(w, 1) >= 2 then
    select id into v from public.perfis p where p.ativo
       and split_part(privado.norm_nome(p.nome), ' ', 1) = w[1]
       and (string_to_array(privado.norm_nome(p.nome), ' '))[array_length(string_to_array(privado.norm_nome(p.nome), ' '), 1)] = w[array_length(w, 1)]
     limit 1;
    if v is not null then return v; end if;
  end if;
  select count(*), min(id::text)::uuid into c, v from public.perfis p
   where p.ativo and split_part(privado.norm_nome(p.nome), ' ', 1) = w[1];
  return case when c = 1 then v end;
end $$;

-- ---------------------------------------------------------------- registrar campanha (sem lançamento)
create or replace function public.registrar_campanha(p_canais text[], p_arquivo text, p_itens jsonb)
 returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  v_uid uuid := auth.uid();
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_nome text; v_ini text; v_base text; v_cod text; v_n int := 1;
  v_camp bigint; v_it jsonb; v_id text; v_setor text; v_tipo text; v_origem text; v_dono uuid; v_qt int := 0;
begin
  if v_uid is null or not privado.sou_ativo() then raise exception 'Acesso não liberado'; end if;
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'Nenhum contribuinte escolhido';
  end if;
  if jsonb_array_length(p_itens) > 500 then raise exception 'No máximo 500 parcelamentos por campanha'; end if;

  select nome into v_nome from public.perfis where id = v_uid;
  v_ini := upper(left(regexp_replace(translate(coalesce(v_nome, 'XX'),
             'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç', 'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc'),
             '(\w)\w*\s*', '\1', 'g'), 4));
  v_ini := regexp_replace(v_ini, '[^A-Z]', '', 'g');
  if char_length(v_ini) < 2 then v_ini := rpad(v_ini, 2, 'X'); end if;
  v_base := 'CAMP-' || to_char(v_hoje, 'YYYYMMDD') || '-' || v_ini;
  v_cod := v_base;
  while exists (select 1 from public.campanhas where codigo = v_cod) loop
    v_n := v_n + 1; v_cod := v_base || '-' || v_n;
  end loop;

  insert into public.campanhas (codigo, funcionario_id, data_envio, canais, arquivo)
  values (v_cod, v_uid, v_hoje, p_canais, left(p_arquivo, 150)) returning id into v_camp;

  for v_it in select * from jsonb_array_elements(p_itens) loop
    v_id := v_it->>'id_parcelamento';
    if v_id is null or v_id !~ '^[0-9A-Za-z./-]{1,30}$' then raise exception 'Id do parcelamento inválido: %', coalesce(v_id, '(vazio)'); end if;
    select funcionario_id into v_dono from public.lista_cobranca where id_parcelamento = v_id;
    if v_dono is not null and v_dono <> v_uid then
      raise exception 'O parcelamento % está na lista de outro cobrador', v_id;
    end if;
    v_setor := nullif(v_it->>'setor', '');
    if v_setor is not null and not exists (select 1 from public.setores where nome = v_setor) then v_setor := null; end if;
    v_tipo := nullif(v_it->>'tipo_cobranca', '');
    if v_tipo is not null and v_tipo not in ('Padrão','Antecipada') then v_tipo := null; end if;
    v_origem := nullif(v_it->>'origem', '');
    if v_origem is not null and v_origem !~ '^[0-9A-Za-z./-]{1,30}$' then v_origem := null; end if;
    insert into public.campanha_itens (campanha_id, id_parcelamento, telefone_hash, tem_email, setor, origem, tipo_cobranca)
    values (v_camp, v_id, nullif(v_it->>'telefone_hash', ''), coalesce((v_it->>'tem_email')::boolean, false), v_setor, v_origem, v_tipo)
    on conflict (campanha_id, id_parcelamento) do nothing;
    v_qt := v_qt + 1;
  end loop;

  return jsonb_build_object('id', v_camp, 'codigo', v_cod, 'itens', v_qt, 'novos', 0, 'marcados', 0);
end $function$;

-- ---------------------------------------------------------------- aviso do CWMKT
drop function if exists public.cwmkt_registrar(text[], text, timestamptz, bigint);
create or replace function public.cwmkt_registrar(p_hashes text[], p_tipo text, p_quando timestamptz, p_conversa bigint,
                                                  p_agente_email text default null, p_agente_nome text default null)
 returns jsonb language plpgsql security definer set search_path to '' as $function$
declare r record; it record; v_func uuid; v_dia date; v_lanc bigint; v_sms boolean; v_res text := null; v_obs text;
begin
  if p_tipo not in ('entrada','saida','abertura') then raise exception 'tipo inválido'; end if;
  select i.id, i.campanha_id, i.cwmkt_atribuida_em, c.codigo, c.canais, c.funcionario_id, p.nome, p.email
    into r
    from public.campanha_itens i
    join public.campanhas c on c.id = i.campanha_id
    join public.perfis p on p.id = c.funcionario_id
   where (i.telefone_hash = any(p_hashes) or (p_conversa is not null and i.cwmkt_conversa = p_conversa))
     and c.data_envio >= ((now() at time zone 'America/Sao_Paulo')::date - 30)
   order by c.data_envio desc, i.id desc
   limit 1;
  if r.id is null then return null; end if;

  update public.campanha_itens i
     set cwmkt_conversa = coalesce(p_conversa, i.cwmkt_conversa),
         retorno_em     = case when p_tipo = 'entrada' then coalesce(i.retorno_em, p_quando) else i.retorno_em end,
         wa_enviado_em  = case when p_tipo = 'saida'   then coalesce(i.wa_enviado_em, p_quando) else i.wa_enviado_em end
   where i.campanha_id = r.campanha_id
     and (i.telefone_hash = any(p_hashes) or i.id = r.id);

  -- primeira resposta de um agente humano: anota quem atendeu e, se for cadastrado, cria o lançamento dele
  if p_tipo = 'saida' and nullif(btrim(coalesce(p_agente_nome, p_agente_email, '')), '') is not null then
    v_func := privado.perfil_do_agente(p_agente_email, p_agente_nome);
    v_dia := (p_quando at time zone 'America/Sao_Paulo')::date;
    v_sms := 'SMS' = any(r.canais);
    v_obs := 'Campanha ' || r.codigo || ' (' || array_to_string(r.canais, ' e ') || ' pela Assertiva) · atendido no WhatsApp';
    for it in select i.* from public.campanha_itens i
               where i.campanha_id = r.campanha_id and (i.telefone_hash = any(p_hashes) or i.id = r.id)
                 and i.atendido_em is null
               order by i.id loop
      v_lanc := null;
      if v_func is not null then
        -- se o agente já tem lançamento em aberto desse Id, só marca a campanha nele
        select l.id into v_lanc from public.lancamentos l
          left join public.situacoes s on s.codigo = l.situacao
         where l.funcionario_id = v_func and l.id_parcelamento = it.id_parcelamento
           and (l.situacao is null or s.categoria = 'Em andamento')
         order by l.data_contato desc, l.id desc limit 1;
        if v_lanc is not null then
          update public.lancamentos
             set campanha_id = r.campanha_id,
                 sms = case when v_sms and sms is null then 'Enviado' else sms end,
                 whatsapp = case when it.retorno_em is not null and (whatsapp is null or whatsapp in ('Enviado','Não respondido')) then 'Respondido'
                                 when whatsapp is null then 'Enviado' else whatsapp end,
                 tipo_cobranca = coalesce(tipo_cobranca, it.tipo_cobranca),
                 observacoes = left(concat_ws(' · ', nullif(observacoes, ''), v_obs), 500)
           where id = v_lanc;
        else
          insert into public.lancamentos (funcionario_id, criado_por, data_contato, id_parcelamento, setor, origem,
                                          fonte_contato, sms, whatsapp, tipo_cobranca, campanha_id, observacoes)
          values (v_func, v_func, v_dia, it.id_parcelamento, it.setor, it.origem, 'Cadastro',
                  case when v_sms then 'Enviado' end,
                  case when it.retorno_em is not null then 'Respondido' else 'Enviado' end,
                  it.tipo_cobranca, r.campanha_id, v_obs)
          returning id into v_lanc;
        end if;
      end if;
      update public.campanha_itens
         set atendido_em = p_quando, atendente_nome = left(coalesce(nullif(btrim(p_agente_nome), ''), p_agente_email), 120),
             atendido_por = v_func, lancamento_id = coalesce(v_lanc, lancamento_id)
       where id = it.id;
      v_res := case when v_func is not null then 'lançado para ' || (select nome from public.perfis where id = v_func)
                    else 'atendido por agente não cadastrado' end;
    end loop;
  end if;

  -- WhatsApp do lançamento já existente (resposta do contribuinte ou nova mensagem)
  if p_tipo in ('entrada','saida') then
    update public.lancamentos l
       set whatsapp = case
             when p_tipo = 'entrada' and (l.whatsapp is null or l.whatsapp in ('Enviado','Não respondido')) then 'Respondido'
             when p_tipo = 'saida' and l.whatsapp is null then 'Enviado'
             else l.whatsapp end
     where l.id in (select i.lancamento_id from public.campanha_itens i
                     where i.campanha_id = r.campanha_id and (i.telefone_hash = any(p_hashes) or i.id = r.id))
       and l.whatsapp is distinct from (case
             when p_tipo = 'entrada' and (l.whatsapp is null or l.whatsapp in ('Enviado','Não respondido')) then 'Respondido'
             when p_tipo = 'saida' and l.whatsapp is null then 'Enviado'
             else l.whatsapp end);
  end if;

  return jsonb_build_object('item', r.id, 'campanha', r.codigo, 'funcionario_id', r.funcionario_id,
                            'nome', r.nome, 'email', r.email, 'ja_atribuida', r.cwmkt_atribuida_em is not null,
                            'atendimento', v_res);
end $function$;
revoke all on function public.cwmkt_registrar(text[], text, timestamptz, bigint, text, text) from public, anon, authenticated;
grant execute on function public.cwmkt_registrar(text[], text, timestamptz, bigint, text, text) to service_role;
revoke all on function privado.perfil_do_agente(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- relatório: atendimento por campanha
create or replace function public.relatorio_campanhas(p_inicio date, p_fim date, p_func uuid default null)
 returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare v_papel text := privado.meu_papel(); v_func uuid := p_func;
begin
  if v_papel is null then raise exception 'Acesso não liberado'; end if;
  if v_papel = 'funcionario' then v_func := auth.uid(); end if;
  return (
    with c as (
      select c.* from public.campanhas c
       where c.data_envio between p_inicio and p_fim and (v_func is null or c.funcionario_id = v_func)
    ), it as (
      select i.campanha_id, i.id_parcelamento, i.tem_email, i.telefone_hash,
             (i.retorno_em is not null and (i.wa_enviado_em is null or i.retorno_em < i.wa_enviado_em)) as antes,
             (i.retorno_em is not null and i.wa_enviado_em is not null and i.retorno_em >= i.wa_enviado_em) as depois,
             (i.atendido_por is not null) as at_cad,
             (i.atendido_em is not null and i.atendido_por is null) as at_outro,
             (i.atendido_em is null and i.retorno_em is not null) as aguardando,
             (s.categoria = 'Pago') as pago,
             case when s.categoria = 'Pago' then coalesce(l.valor_pago, 0) else 0 end as valor
        from public.campanha_itens i join c on c.id = i.campanha_id
        left join public.lancamentos l on l.id = i.lancamento_id
        left join public.situacoes s on s.codigo = l.situacao
    ), por_camp as (
      select c.id, c.codigo, c.data_envio, c.canais, c.funcionario_id, p.nome as cobrador,
             count(it.*) as parcelamentos,
             count(distinct coalesce(it.telefone_hash, it.id_parcelamento)) as contribuintes,
             count(*) filter (where it.tem_email) as com_email,
             count(*) filter (where it.antes) as antes, count(*) filter (where it.depois) as depois,
             count(*) filter (where it.at_cad) as at_cad, count(*) filter (where it.at_outro) as at_outro,
             count(*) filter (where it.aguardando) as aguardando,
             count(*) filter (where it.pago) as pagos, coalesce(sum(it.valor), 0) as valor
        from c join public.perfis p on p.id = c.funcionario_id
        left join it on it.campanha_id = c.id
       group by c.id, c.codigo, c.data_envio, c.canais, c.funcionario_id, p.nome
    )
    select jsonb_build_object(
      'campanhas', coalesce((select jsonb_agg(to_jsonb(x) order by x.data_envio desc, x.id desc) from por_camp x), '[]'::jsonb),
      'por_cobrador', coalesce((select jsonb_agg(to_jsonb(y) order by y.cobrador) from (
          select funcionario_id, cobrador, count(*) as campanhas, sum(parcelamentos) as parcelamentos, sum(contribuintes) as contribuintes,
                 sum(antes) as antes, sum(depois) as depois, sum(at_cad) as at_cad, sum(at_outro) as at_outro,
                 sum(pagos) as pagos, sum(valor) as valor
            from por_camp group by funcionario_id, cobrador) y), '[]'::jsonb),
      'totais', (select jsonb_build_object('campanhas', count(*), 'parcelamentos', coalesce(sum(parcelamentos), 0),
                  'contribuintes', coalesce(sum(contribuintes), 0), 'com_email', coalesce(sum(com_email), 0),
                  'sms', coalesce(sum(parcelamentos) filter (where 'SMS' = any(canais)), 0),
                  'email', coalesce(sum(com_email) filter (where 'E-mail' = any(canais)), 0),
                  'antes', coalesce(sum(antes), 0), 'depois', coalesce(sum(depois), 0),
                  'at_cad', coalesce(sum(at_cad), 0), 'at_outro', coalesce(sum(at_outro), 0),
                  'aguardando', coalesce(sum(aguardando), 0),
                  'pagos', coalesce(sum(pagos), 0), 'valor', coalesce(sum(valor), 0)) from por_camp),
      'retorno_ativo', exists (select 1 from public.campanha_itens where retorno_em is not null or wa_enviado_em is not null)
    )
  );
end $function$;
