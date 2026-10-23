-- =====================================================================
-- COBRANÇAS PMO – Novos parcelamentos efetivados (23/10/2026)
-- * Situações ganham dois indicadores:
--     novo_acordo        → situação de novo parcelamento efetivado (habilita valor total e nº do acordo)
--     confere_efetivacao → o sistema avisa, a partir do dia seguinte, para conferir se o acordo foi efetivado
-- * Lançamentos: valor_acordo (valor total do novo acordo), novo_parcelamento (nº do novo
--   parcelamento) e situacao_desde (data em que o caso entrou na situação atual).
-- * Nova situação "PARCELAMENTO EFETIVADO" (categoria Pago); "ENCAMINHADO PARA PARCELAMENTO"
--   passa a conferir efetivação.
-- * Relatório: novos parcelamentos efetivados, valor regularizado (total dos acordos) e entradas.
-- =====================================================================

alter table public.situacoes add column if not exists novo_acordo boolean not null default false;
alter table public.situacoes add column if not exists confere_efetivacao boolean not null default false;

alter table public.lancamentos add column if not exists valor_acordo numeric(12,2) check (valor_acordo >= 0);
alter table public.lancamentos add column if not exists novo_parcelamento text check (novo_parcelamento ~ '^[0-9A-Za-z./-]{1,30}$');
alter table public.lancamentos add column if not exists situacao_desde date;
update public.lancamentos
   set situacao_desde = coalesce((atualizado_em at time zone 'America/Sao_Paulo')::date, data_contato)
 where situacao_desde is null and situacao is not null;

insert into public.situacoes (codigo, categoria, descricao, ordem, novo_acordo)
values ('PARCELAMENTO EFETIVADO', 'Pago',
        'Novo parcelamento efetivado (após agendamento ou encaminhamento). Informe a entrada/1ª parcela paga, o valor total do acordo e o nº do novo parcelamento.',
        11, true)
on conflict (codigo) do update set categoria = 'Pago', novo_acordo = true, ativo = true;

update public.situacoes set confere_efetivacao = true where codigo = 'ENCAMINHADO PARA PARCELAMENTO';

create or replace function public.lancamento_antes_gravar() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_gera   boolean;
  v_cat    text;
  v_novo   boolean;
  v_gestor boolean := auth.uid() is null or coalesce(privado.meu_papel(), '') in ('supervisor','admin');
begin
  if tg_op = 'UPDATE' then
    if new.funcionario_id <> old.funcionario_id then
      raise exception 'Não é permitido transferir o lançamento para outro funcionário';
    end if;
    new.criado_em := old.criado_em;
    new.criado_por := old.criado_por;
    -- data em que o caso entrou na situação atual (para o aviso de efetivação do parcelamento)
    if new.situacao is distinct from old.situacao then
      new.situacao_desde := case when new.situacao is null then null else (now() at time zone 'America/Sao_Paulo')::date end;
    else
      new.situacao_desde := old.situacao_desde;
    end if;
    if not v_gestor then
      new.cancelamento_status        := old.cancelamento_status;
      new.cancelamento_lote          := old.cancelamento_lote;
      new.cancelamento_obs           := old.cancelamento_obs;
      new.cancelamento_atualizado_em := old.cancelamento_atualizado_em;
    end if;
  else
    -- inclusão: quem digitou fica registrado; em nome de outro, só administrador e para atendente ativo
    new.situacao_desde := case when new.situacao is null then null else (now() at time zone 'America/Sao_Paulo')::date end;
    if auth.uid() is not null then
      new.criado_por := auth.uid();
      if new.funcionario_id is distinct from auth.uid() then
        if coalesce(privado.meu_papel(), '') <> 'admin' then
          raise exception 'Somente o administrador pode lançar em nome de outro atendente';
        end if;
        if not exists (select 1 from public.perfis p where p.id = new.funcionario_id and p.ativo) then
          raise exception 'Atendente inativo ou inexistente';
        end if;
      end if;
    end if;
    if not v_gestor then
      new.cancelamento_status := null; new.cancelamento_lote := null;
      new.cancelamento_obs := null;    new.cancelamento_atualizado_em := null;
    end if;
  end if;

  select s.gera_cancelamento, s.categoria, s.novo_acordo into v_gera, v_cat, v_novo from public.situacoes s where s.codigo = new.situacao;

  -- valor total e nº do novo acordo só existem em situações de "novo parcelamento"
  if not coalesce(v_novo, false) then
    new.valor_acordo := null;
    new.novo_parcelamento := null;
  end if;

  if coalesce(v_gera, false) then
    if new.cancelamento_status is null then
      new.cancelamento_status := 'Aguardando envio';
      new.cancelamento_atualizado_em := now();
    end if;
  elsif new.cancelamento_status in ('Aguardando envio','Retirado') and new.cancelamento_lote is null then
    new.cancelamento_status := null;
    new.cancelamento_atualizado_em := now();
  end if;

  if v_cat = 'Pago' then
    if new.data_pagamento is null then
      new.data_pagamento := (now() at time zone 'America/Sao_Paulo')::date;
    end if;
  else
    new.data_pagamento := null;
  end if;

  new.atualizado_em := now();
  new.atualizado_por := auth.uid();
  return new;
end $$;
revoke all on function public.lancamento_antes_gravar() from public, anon, authenticated;

create or replace function public.relatorio(p_inicio date, p_fim date, p_func uuid default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
with cat as (
  select l.*,
         case when l.situacao is null then 'Sem situação' else coalesce(s.categoria, 'Outros') end as categoria,
         coalesce(s.novo_acordo, false) as eh_novo_acordo
  from public.lancamentos l
  left join public.situacoes s on s.codigo = l.situacao
  where (p_func is null or l.funcionario_id = p_func)
    and (l.data_contato between p_inicio and p_fim or l.data_pagamento between p_inicio and p_fim)
),
base as (select * from cat where data_contato between p_inicio and p_fim),                       -- contatos do período
pag  as (select * from cat where categoria = 'Pago' and data_pagamento between p_inicio and p_fim) -- pagamentos do período
select jsonb_build_object(
  'totais', jsonb_build_object(
      'contatos',       (select count(*) from base),
      'whatsapp',       (select count(*) from base where whatsapp in ('Enviado','Respondido','Não respondido')),
      'sms',            (select count(sms) from base),
      'ligacoes',       (select count(ligacao) from base),
      'agendamentos',   (select count(agendamento) from base),
      'boletos',        (select count(boleto_emitido) from base),
      'valor_boletos',  (select coalesce(sum(valor_boleto), 0) from base where boleto_emitido is not null),
      'pagos_contatos', (select count(*) from base where categoria = 'Pago'),
      'andamento',      (select count(*) from base where categoria = 'Em andamento'),
      'revogados',      (select count(*) from base where categoria = 'Revogado'),
      'outros',         (select count(*) from base where categoria = 'Outros'),
      'sem_situacao',   (select count(*) from base where categoria = 'Sem situação'),
      'pagos',          (select count(*) from pag),
      'valor',          (select coalesce(sum(valor_pago), 0) from pag),
      'parcelas',       (select coalesce(sum(parcelas), 0) from pag),
      'pago_sem_valor', (select count(*) from pag where valor_pago is null),
      'novos_acordos',  (select count(*) from pag where eh_novo_acordo),
      'valor_acordos',  (select coalesce(sum(valor_acordo), 0) from pag where eh_novo_acordo),
      'entrada_acordos', (select coalesce(sum(valor_pago), 0) from pag where eh_novo_acordo),
      'dias',           (select count(distinct (funcionario_id, data_contato)) from base),
      'funcionarios',   (select count(*) from (select funcionario_id from base union select funcionario_id from pag) u),
      'canc_aguardando', (select count(*) from base where cancelamento_status = 'Aguardando envio'),
      'canc_enviados',   (select count(*) from base where cancelamento_status in ('Enviado','Cancelado','Devolvido')),
      'canc_cancelados', (select count(*) from base where cancelamento_status = 'Cancelado'),
      'canc_devolvidos', (select count(*) from base where cancelamento_status = 'Devolvido')
    ),
  'por_dia', (select coalesce(jsonb_agg(x order by x.dia), '[]'::jsonb) from (
      select d as dia, coalesce(c.contatos, 0) as contatos, coalesce(c.boletos, 0) as boletos,
             coalesce(p.pagos, 0) as pagos, coalesce(p.valor, 0) as valor
      from (select data_contato as d, count(*) as contatos, count(boleto_emitido) as boletos from base group by 1) c
      full join (select data_pagamento as d, count(*) as pagos, coalesce(sum(valor_pago), 0) as valor from pag group by 1) p using (d)) x),
  'por_mes', (select coalesce(jsonb_agg(x order by x.mes), '[]'::jsonb) from (
      select m as mes, coalesce(c.contatos, 0) as contatos, coalesce(c.boletos, 0) as boletos, coalesce(c.revogados, 0) as revogados,
             coalesce(p.pagos, 0) as pagos, coalesce(p.valor, 0) as valor
      from (select to_char(data_contato, 'YYYY-MM') as m, count(*) as contatos, count(boleto_emitido) as boletos,
                   count(*) filter (where categoria = 'Revogado') as revogados from base group by 1) c
      full join (select to_char(data_pagamento, 'YYYY-MM') as m, count(*) as pagos, coalesce(sum(valor_pago), 0) as valor from pag group by 1) p using (m)) x),
  'por_categoria', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select categoria, count(*) as qtde from base group by categoria) x),
  'por_situacao', (select coalesce(jsonb_agg(x order by x.ordem, x.situacao), '[]'::jsonb) from (
      select s.codigo as situacao, s.categoria, s.ordem, count(b.id) as qtde
      from public.situacoes s left join base b on b.situacao = s.codigo
      group by s.codigo, s.categoria, s.ordem) x),
  'por_setor', (select coalesce(jsonb_agg(x order by x.contatos desc, x.valor desc), '[]'::jsonb) from (
      select k as setor, coalesce(c.contatos, 0) as contatos, coalesce(c.pagos_contatos, 0) as pagos_contatos,
             coalesce(p.pagos, 0) as pagos, coalesce(p.valor, 0) as valor
      from (select coalesce(setor, '(não informado)') as k, count(*) as contatos,
                   count(*) filter (where categoria = 'Pago') as pagos_contatos from base group by 1) c
      full join (select coalesce(setor, '(não informado)') as k, count(*) as pagos, coalesce(sum(valor_pago), 0) as valor from pag group by 1) p using (k)) x),
  'por_funcionario', (select coalesce(jsonb_agg(x order by x.valor desc, x.contatos desc), '[]'::jsonb) from (
      select f as id, coalesce(pf.nome, '—') as nome, coalesce(c.contatos, 0) as contatos, coalesce(c.boletos, 0) as boletos,
             coalesce(c.pagos_contatos, 0) as pagos_contatos, coalesce(c.andamento, 0) as andamento, coalesce(c.revogados, 0) as revogados,
             coalesce(c.dias, 0) as dias, coalesce(p.pagos, 0) as pagos, coalesce(p.valor, 0) as valor
      from (select funcionario_id as f, count(*) as contatos, count(boleto_emitido) as boletos,
                   count(*) filter (where categoria = 'Pago') as pagos_contatos,
                   count(*) filter (where categoria = 'Em andamento') as andamento,
                   count(*) filter (where categoria = 'Revogado') as revogados,
                   count(distinct data_contato) as dias
            from base group by 1) c
      full join (select funcionario_id as f, count(*) as pagos, coalesce(sum(valor_pago), 0) as valor from pag group by 1) p using (f)
      left join public.perfis pf on pf.id = f) x)
)
$$;
revoke all on function public.relatorio(date, date, uuid) from public, anon;
grant execute on function public.relatorio(date, date, uuid) to authenticated;
