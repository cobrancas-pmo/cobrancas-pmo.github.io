-- =====================================================================
-- COBRANÇAS PMO – Eficácia dos meios de cobrança (20/10/2026)
-- * Novo campo opcional meio_acordo: qual meio efetivamente gerou o acordo/pagamento.
-- * Função relatorio_eficacia: cruza as ações registradas (WhatsApp, SMS,
--   ligação, agendamento), a fonte do telefone, o setor e o dia da semana com
--   o resultado dos contatos do período (pela DATA DO CONTATO).
-- =====================================================================

alter table public.lancamentos add column if not exists meio_acordo text;
do $$ begin
  alter table public.lancamentos add constraint lancamentos_meio_acordo_check
    check (meio_acordo in ('WhatsApp','SMS','Ligação','Atendimento presencial','Contribuinte procurou'));
exception when duplicate_object then null; end $$;

create or replace function public.relatorio_eficacia(p_inicio date, p_fim date, p_func uuid default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
with base as (
  select l.*,
         case when l.situacao is null then 'Sem situação' else coalesce(s.categoria, 'Outros') end as categoria
  from public.lancamentos l
  left join public.situacoes s on s.codigo = l.situacao
  where (p_func is null or l.funcionario_id = p_func)
    and l.data_contato between p_inicio and p_fim
),
b as (
  select x.*,
         (x.categoria = 'Pago')                                                         as pago,
         coalesce(x.whatsapp = 'Respondido' or x.sms = 'Respondido' or x.ligacao = 'Atendida', false) as respondeu,
         coalesce(x.ligacao = 'Número errado', false) or coalesce(x.whatsapp = 'Sem WhatsApp', false) as contato_falho,
         case when x.categoria = 'Pago' and x.data_pagamento is not null
              then greatest(x.data_pagamento - x.data_contato, 0) end                     as dias_pag,
         coalesce(x.whatsapp in ('Enviado','Respondido'), false) as u_wpp,
         (x.sms is not null)          as u_sms,
         (x.ligacao is not null)      as u_lig,
         (x.agendamento is not null)  as u_age
  from base x
),
m as (   -- uma linha por (lançamento, meio utilizado)
  select b.*, v.meio, v.ordem
  from b cross join lateral (values ('WhatsApp', 1, b.u_wpp), ('SMS', 2, b.u_sms),
                                    ('Ligação', 3, b.u_lig), ('Agendamento', 4, b.u_age)) v(meio, ordem, usado)
  where v.usado
  union all
  select b.*, 'Nenhuma ação registrada', 9 from b where not (b.u_wpp or b.u_sms or b.u_lig or b.u_age)
),
r as (   -- resposta obtida em cada meio
  select b.*, v.meio, v.ordem, v.resp
  from b cross join lateral (values ('WhatsApp', 1, b.whatsapp), ('SMS', 2, b.sms), ('Ligação', 3, b.ligacao)) v(meio, ordem, resp)
  where v.resp is not null
)
select jsonb_build_object(
  'total', (select jsonb_build_object(
      'contatos', count(*), 'pagos', count(*) filter (where pago),
      'valor', coalesce(sum(valor_pago) filter (where pago), 0),
      'respondeu', count(*) filter (where respondeu),
      'contato_falho', count(*) filter (where contato_falho),
      'dias_medio', round(avg(dias_pag), 1),
      'pagos_com_meio', count(*) filter (where pago and meio_acordo is not null),
      'acordos_com_meio', count(*) filter (where meio_acordo is not null)) from b),
  'por_meio', (select coalesce(jsonb_agg(x order by x.ordem), '[]'::jsonb) from (
      select meio, ordem, count(*) as contatos, count(*) filter (where pago) as pagos,
             count(*) filter (where categoria = 'Em andamento') as andamento,
             count(*) filter (where categoria = 'Revogado') as sem_sucesso,
             count(*) filter (where respondeu) as respondeu,
             coalesce(sum(valor_pago) filter (where pago), 0) as valor,
             round(avg(dias_pag), 1) as dias_medio
      from m group by meio, ordem) x),
  'por_resposta', (select coalesce(jsonb_agg(x order by x.ordem, x.contatos desc), '[]'::jsonb) from (
      select meio, ordem, resp, count(*) as contatos, count(*) filter (where pago) as pagos,
             coalesce(sum(valor_pago) filter (where pago), 0) as valor
      from r group by meio, ordem, resp) x),
  'combinacoes', (select coalesce(jsonb_agg(x order by x.contatos desc, x.pagos desc), '[]'::jsonb) from (
      select coalesce(nullif(concat_ws(' + ', case when u_wpp then 'WhatsApp' end, case when u_sms then 'SMS' end,
                                              case when u_lig then 'Ligação' end, case when u_age then 'Agendamento' end), ''),
                      'Nenhuma ação registrada') as combinacao,
             (u_wpp::int + u_sms::int + u_lig::int + u_age::int) as qtd_meios,
             count(*) as contatos, count(*) filter (where pago) as pagos,
             coalesce(sum(valor_pago) filter (where pago), 0) as valor,
             round(avg(dias_pag), 1) as dias_medio
      from b group by 1, 2) x),
  'por_fonte', (select coalesce(jsonb_agg(x order by x.contatos desc), '[]'::jsonb) from (
      select coalesce(fonte_contato, '(não informada)') as fonte, count(*) as contatos,
             count(*) filter (where respondeu) as respondeu,
             count(*) filter (where contato_falho) as contato_falho,
             count(*) filter (where pago) as pagos,
             coalesce(sum(valor_pago) filter (where pago), 0) as valor
      from b group by 1) x),
  'por_setor_meio', (select coalesce(jsonb_agg(x order by x.setor, x.ordem), '[]'::jsonb) from (
      select coalesce(setor, '(não informado)') as setor, meio, ordem,
             count(*) as contatos, count(*) filter (where pago) as pagos
      from m group by 1, 2, 3) x),
  'por_dia_semana', (select coalesce(jsonb_agg(x order by x.dow), '[]'::jsonb) from (
      select extract(dow from data_contato)::int as dow, count(*) as contatos,
             count(*) filter (where respondeu) as respondeu, count(*) filter (where pago) as pagos
      from b group by 1) x),
  'meio_acordo', (select coalesce(jsonb_agg(x order by x.acordos desc), '[]'::jsonb) from (
      select meio_acordo as meio, count(*) as acordos, count(*) filter (where pago) as pagos,
             coalesce(sum(valor_pago) filter (where pago), 0) as valor,
             round(avg(dias_pag), 1) as dias_medio
      from b where meio_acordo is not null group by 1) x)
)
$$;
revoke all on function public.relatorio_eficacia(date, date, uuid) from public, anon;
grant execute on function public.relatorio_eficacia(date, date, uuid) to authenticated;
