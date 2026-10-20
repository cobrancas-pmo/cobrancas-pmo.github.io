-- =====================================================================
-- COBRANÇAS PMO – Data do pagamento (20/10/2026)
-- * Novo campo data_pagamento: preenchido na conferência (padrão: hoje).
-- * Relatórios: contatos/ações pela DATA DO CONTATO;
--   pagamentos, valor arrecadado e parcelas pela DATA DO PAGAMENTO.
-- =====================================================================

alter table public.lancamentos add column if not exists data_pagamento date;
create index if not exists lancamentos_data_pagamento_idx on public.lancamentos (data_pagamento);

-- Gatilho: além da fila de cancelamento, mantém a data do pagamento coerente
create or replace function public.lancamento_antes_gravar() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_gera   boolean;
  v_cat    text;
  v_gestor boolean := auth.uid() is null or coalesce(privado.meu_papel(), '') in ('supervisor','admin');
begin
  if tg_op = 'UPDATE' then
    if new.funcionario_id <> old.funcionario_id then
      raise exception 'Não é permitido transferir o lançamento para outro funcionário';
    end if;
    new.criado_em := old.criado_em;
    if not v_gestor then
      new.cancelamento_status        := old.cancelamento_status;
      new.cancelamento_lote          := old.cancelamento_lote;
      new.cancelamento_obs           := old.cancelamento_obs;
      new.cancelamento_atualizado_em := old.cancelamento_atualizado_em;
    end if;
  elsif not v_gestor then
    new.cancelamento_status := null; new.cancelamento_lote := null;
    new.cancelamento_obs := null;    new.cancelamento_atualizado_em := null;
  end if;

  select s.gera_cancelamento, s.categoria into v_gera, v_cat from public.situacoes s where s.codigo = new.situacao;

  -- fila de cancelamento
  if coalesce(v_gera, false) then
    if new.cancelamento_status is null then
      new.cancelamento_status := 'Aguardando envio';
      new.cancelamento_atualizado_em := now();
    end if;
  elsif new.cancelamento_status in ('Aguardando envio','Retirado') and new.cancelamento_lote is null then
    new.cancelamento_status := null;
    new.cancelamento_atualizado_em := now();
  end if;

  -- data do pagamento: só existe quando a situação é de pagamento
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

-- Pagamentos já lançados: usa a data de emissão do boleto (ou, sem ela, a do contato)
update public.lancamentos l
   set data_pagamento = coalesce(l.boleto_emitido, l.data_contato)
 where l.data_pagamento is null
   and l.situacao in (select codigo from public.situacoes where categoria = 'Pago');

-- Relatório
create or replace function public.relatorio(p_inicio date, p_fim date, p_func uuid default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
with cat as (
  select l.*,
         case when l.situacao is null then 'Sem situação' else coalesce(s.categoria, 'Outros') end as categoria
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
      'whatsapp',       (select count(*) from base where whatsapp in ('Enviado','Respondido')),
      'sms',            (select count(sms) from base),
      'ligacoes',       (select count(ligacao) from base),
      'agendamentos',   (select count(agendamento) from base),
      'boletos',        (select count(boleto_emitido) from base),
      'pagos_contatos', (select count(*) from base where categoria = 'Pago'),
      'andamento',      (select count(*) from base where categoria = 'Em andamento'),
      'revogados',      (select count(*) from base where categoria = 'Revogado'),
      'outros',         (select count(*) from base where categoria = 'Outros'),
      'sem_situacao',   (select count(*) from base where categoria = 'Sem situação'),
      'pagos',          (select count(*) from pag),
      'valor',          (select coalesce(sum(valor_pago), 0) from pag),
      'parcelas',       (select coalesce(sum(parcelas), 0) from pag),
      'pago_sem_valor', (select count(*) from pag where valor_pago is null),
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
