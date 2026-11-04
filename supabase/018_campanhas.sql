-- =====================================================================
-- COBRANÇAS PMO – Campanhas de SMS/e-mail pela Assertiva (04/11/2026)
-- Cada cobrador sobe a própria lista do SMAR, escolhe os contribuintes do dia
-- e baixa a planilha no modelo da Assertiva. Ao registrar a campanha, o
-- sistema cria (ou marca) os lançamentos do dia.
-- Sem dados pessoais: nome, CPF, telefone e e-mail ficam só no navegador; aqui
-- ficam o Id do parcelamento, quem enviou e o telefone embaralhado (SHA-256),
-- usado depois para reconhecer o retorno pelo WhatsApp (CWMKT).
-- =====================================================================

-- ---------- Campanha (um disparo de um cobrador) ----------
create table if not exists public.campanhas (
  id             bigint generated always as identity primary key,
  codigo         text not null unique check (codigo ~ '^CAMP-[0-9]{8}-[A-Z]{2,4}(-[0-9]{1,3})?$'),
  funcionario_id uuid not null default auth.uid() references public.perfis(id),
  data_envio     date not null default ((now() at time zone 'America/Sao_Paulo')::date),
  canais         text[] not null check (cardinality(canais) between 1 and 2 and canais <@ array['SMS','E-mail']),
  arquivo        text check (char_length(arquivo) <= 150),
  criada_em      timestamptz not null default now()
);
create index if not exists campanhas_func_data_idx on public.campanhas (funcionario_id, data_envio);

-- ---------- Contribuintes de cada campanha (um por parcelamento) ----------
create table if not exists public.campanha_itens (
  id              bigint generated always as identity primary key,
  campanha_id     bigint not null references public.campanhas(id) on delete cascade,
  id_parcelamento text not null check (id_parcelamento ~ '^[0-9A-Za-z./-]{1,30}$'),
  telefone_hash   text check (telefone_hash ~ '^[0-9a-f]{64}$'),
  tem_email       boolean not null default false,
  lancamento_id   bigint references public.lancamentos(id) on delete set null,
  wa_enviado_em   timestamptz,     -- 1ª mensagem do cobrador pelo WhatsApp (preenchido pela ligação com o CWMKT)
  retorno_em      timestamptz,     -- 1ª resposta do contribuinte pelo WhatsApp (idem)
  unique (campanha_id, id_parcelamento)
);
create index if not exists campanha_itens_parc_idx on public.campanha_itens (id_parcelamento);
create index if not exists campanha_itens_tel_idx on public.campanha_itens (telefone_hash);

-- ---------- Divisão da lista do SMAR: de quem é cada parcelamento ----------
create table if not exists public.lista_cobranca (
  id_parcelamento text primary key check (id_parcelamento ~ '^[0-9A-Za-z./-]{1,30}$'),
  funcionario_id  uuid not null references public.perfis(id),
  valor           numeric(12,2),
  dividido_em     timestamptz not null default now(),
  dividido_por    uuid default auth.uid()
);
create index if not exists lista_cobranca_func_idx on public.lista_cobranca (funcionario_id);

-- ---------- Lançamento ligado à campanha ----------
alter table public.lancamentos add column if not exists campanha_id bigint references public.campanhas(id) on delete set null;
create index if not exists lancamentos_campanha_idx on public.lancamentos (campanha_id) where campanha_id is not null;

-- ---------- Segurança ----------
alter table public.campanhas      enable row level security;
alter table public.campanha_itens enable row level security;
alter table public.lista_cobranca enable row level security;
revoke all on public.campanhas, public.campanha_itens, public.lista_cobranca from anon, authenticated;
grant select on public.campanhas, public.campanha_itens, public.lista_cobranca to authenticated;
grant delete on public.campanhas to authenticated;

drop policy if exists camp_ler on public.campanhas;
create policy camp_ler on public.campanhas for select to authenticated
  using ((funcionario_id = (select auth.uid()) and (select privado.sou_ativo()))
         or (select privado.meu_papel()) in ('supervisor','admin'));
drop policy if exists camp_excluir on public.campanhas;
create policy camp_excluir on public.campanhas for delete to authenticated
  using ((select privado.meu_papel()) = 'admin');
drop policy if exists campitem_ler on public.campanha_itens;
create policy campitem_ler on public.campanha_itens for select to authenticated
  using (exists (select 1 from public.campanhas c where c.id = campanha_id));   -- herda a regra da campanha
drop policy if exists lista_ler on public.lista_cobranca;
create policy lista_ler on public.lista_cobranca for select to authenticated
  using ((funcionario_id = (select auth.uid()) and (select privado.sou_ativo()))
         or (select privado.meu_papel()) in ('supervisor','admin'));

drop trigger if exists auditar on public.campanhas;
create trigger auditar after insert or update or delete on public.campanhas
  for each row execute function public.registrar_auditoria();

-- ---------- Registrar campanha ----------
-- p_itens: [{"id_parcelamento":"106326","telefone_hash":"…","tem_email":true,
--            "setor":"Imobiliário","origem":"20779","tipo_cobranca":"Antecipada"}, …]
-- Para cada parcelamento: se o cobrador já tem um lançamento em aberto (sem situação
-- ou "em andamento"), marca nele a campanha; senão cria um lançamento com a data de hoje.
create or replace function public.registrar_campanha(p_canais text[], p_arquivo text, p_itens jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_nome text; v_ini text; v_base text; v_cod text; v_n int := 1;
  v_camp bigint; v_it jsonb; v_id text; v_lanc bigint; v_setor text; v_tipo text; v_origem text;
  v_novos int := 0; v_marcados int := 0; v_dono uuid;
  v_sms boolean := 'SMS' = any(p_canais);
  v_obs text;
begin
  if v_uid is null or not privado.sou_ativo() then raise exception 'Acesso não liberado'; end if;
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'Nenhum contribuinte escolhido';
  end if;
  if jsonb_array_length(p_itens) > 500 then raise exception 'No máximo 500 parcelamentos por campanha'; end if;

  -- código: CAMP-AAAAMMDD-INICIAIS (ex.: CAMP-20261104-AL), com -2, -3… se repetir no dia
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
  v_obs := 'Campanha ' || v_cod || ' (' || array_to_string(p_canais, ' e ') || ' pela Assertiva)';

  for v_it in select * from jsonb_array_elements(p_itens) loop
    v_id := v_it->>'id_parcelamento';
    if v_id is null or v_id !~ '^[0-9A-Za-z./-]{1,30}$' then raise exception 'Id do parcelamento inválido: %', coalesce(v_id, '(vazio)'); end if;
    -- respeita a divisão da lista: parcelamento de outro cobrador não entra
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

    select l.id into v_lanc from public.lancamentos l
      left join public.situacoes s on s.codigo = l.situacao
     where l.funcionario_id = v_uid and l.id_parcelamento = v_id
       and (l.situacao is null or s.categoria = 'Em andamento')
     order by l.data_contato desc, l.id desc limit 1;
    if v_lanc is not null then
      update public.lancamentos
         set campanha_id = v_camp,
             sms = case when v_sms and sms is null then 'Enviado' else sms end,
             tipo_cobranca = coalesce(tipo_cobranca, v_tipo),
             observacoes = left(concat_ws(' · ', nullif(observacoes, ''), v_obs), 500)
       where id = v_lanc;
      v_marcados := v_marcados + 1;
    else
      insert into public.lancamentos (funcionario_id, criado_por, data_contato, id_parcelamento, setor, origem,
                                      fonte_contato, sms, tipo_cobranca, campanha_id, observacoes)
      values (v_uid, v_uid, v_hoje, v_id, v_setor, v_origem, 'Cadastro',
              case when v_sms then 'Enviado' end, v_tipo, v_camp, v_obs)
      returning id into v_lanc;
      v_novos := v_novos + 1;
    end if;
    insert into public.campanha_itens (campanha_id, id_parcelamento, telefone_hash, tem_email, lancamento_id)
    values (v_camp, v_id, nullif(v_it->>'telefone_hash', ''), coalesce((v_it->>'tem_email')::boolean, false), v_lanc)
    on conflict (campanha_id, id_parcelamento) do nothing;
  end loop;

  return jsonb_build_object('id', v_camp, 'codigo', v_cod, 'novos', v_novos, 'marcados', v_marcados);
end $$;
revoke all on function public.registrar_campanha(text[], text, jsonb) from public, anon;
grant execute on function public.registrar_campanha(text[], text, jsonb) to authenticated;

-- ---------- Parcelamentos que já receberam campanha (para não repetir) ----------
create or replace function public.ja_em_campanha(p_ids text[])
returns table (id_parcelamento text, data_envio date, codigo text)
language sql stable security definer set search_path = '' as $$
  select distinct on (i.id_parcelamento) i.id_parcelamento, c.data_envio, c.codigo
    from public.campanha_itens i join public.campanhas c on c.id = i.campanha_id
   where privado.sou_ativo() and i.id_parcelamento = any(p_ids)
   order by i.id_parcelamento, c.data_envio desc
$$;
revoke all on function public.ja_em_campanha(text[]) from public, anon;
grant execute on function public.ja_em_campanha(text[]) to authenticated;

-- ---------- Parcelamentos que estão na lista de outro cobrador ----------
create or replace function public.lista_de_outros(p_ids text[])
returns setof text language sql stable security definer set search_path = '' as $$
  select l.id_parcelamento from public.lista_cobranca l
   where privado.sou_ativo() and l.id_parcelamento = any(p_ids) and l.funcionario_id <> auth.uid()
$$;
revoke all on function public.lista_de_outros(text[]) from public, anon;
grant execute on function public.lista_de_outros(text[]) to authenticated;

-- ---------- Salvar a divisão da lista (supervisão/administração) ----------
-- p_itens: [{"id_parcelamento":"106326","funcionario_id":"…","valor":6682.20}, …]
create or replace function public.salvar_divisao(p_itens jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_qtd int;
begin
  if coalesce(privado.meu_papel(), '') not in ('supervisor','admin') then
    raise exception 'Somente a supervisão pode dividir a lista';
  end if;
  insert into public.lista_cobranca (id_parcelamento, funcionario_id, valor, dividido_em, dividido_por)
  select x->>'id_parcelamento', (x->>'funcionario_id')::uuid, nullif(x->>'valor', '')::numeric, now(), auth.uid()
    from jsonb_array_elements(p_itens) x
   where exists (select 1 from public.perfis p where p.id = (x->>'funcionario_id')::uuid and p.ativo)
  on conflict (id_parcelamento) do update
    set funcionario_id = excluded.funcionario_id, valor = excluded.valor,
        dividido_em = excluded.dividido_em, dividido_por = excluded.dividido_por;
  get diagnostics v_qtd = row_count;
  return v_qtd;
end $$;
revoke all on function public.salvar_divisao(jsonb) from public, anon;
grant execute on function public.salvar_divisao(jsonb) to authenticated;

-- ---------- Relatório das campanhas ----------
-- Contribuintes, retornos pelo WhatsApp (antes/depois da 1ª mensagem do cobrador),
-- pagos e valor (lançamentos ligados à campanha). Período pela data de envio.
create or replace function public.relatorio_campanhas(p_inicio date, p_fim date, p_func uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
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
             count(*) filter (where it.pago) as pagos, coalesce(sum(it.valor), 0) as valor
        from c join public.perfis p on p.id = c.funcionario_id
        left join it on it.campanha_id = c.id
       group by c.id, c.codigo, c.data_envio, c.canais, c.funcionario_id, p.nome
    )
    select jsonb_build_object(
      'campanhas', coalesce((select jsonb_agg(to_jsonb(x) order by x.data_envio desc, x.id desc) from por_camp x), '[]'::jsonb),
      'por_cobrador', coalesce((select jsonb_agg(to_jsonb(y) order by y.cobrador) from (
          select funcionario_id, cobrador, count(*) as campanhas, sum(parcelamentos) as parcelamentos, sum(contribuintes) as contribuintes,
                 sum(antes) as antes, sum(depois) as depois, sum(pagos) as pagos, sum(valor) as valor
            from por_camp group by funcionario_id, cobrador) y), '[]'::jsonb),
      'totais', (select jsonb_build_object('campanhas', count(*), 'parcelamentos', coalesce(sum(parcelamentos), 0),
                  'contribuintes', coalesce(sum(contribuintes), 0), 'com_email', coalesce(sum(com_email), 0),
                  'sms', coalesce(sum(parcelamentos) filter (where 'SMS' = any(canais)), 0),
                  'email', coalesce(sum(com_email) filter (where 'E-mail' = any(canais)), 0),
                  'antes', coalesce(sum(antes), 0), 'depois', coalesce(sum(depois), 0),
                  'pagos', coalesce(sum(pagos), 0), 'valor', coalesce(sum(valor), 0)) from por_camp),
      'retorno_ativo', exists (select 1 from public.campanha_itens where retorno_em is not null or wa_enviado_em is not null)
    )
  );
end $$;
revoke all on function public.relatorio_campanhas(date, date, uuid) from public, anon;
grant execute on function public.relatorio_campanhas(date, date, uuid) to authenticated;
