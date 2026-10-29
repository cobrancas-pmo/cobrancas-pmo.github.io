-- =====================================================================
-- COBRANÇAS PMO – Tipo de cobrança (29/10/2026)
-- Separa a cobrança "Padrão" (acordo com 3 ou mais parcelas vencidas) da
-- cobrança "Antecipada" (menos de 3 parcelas vencidas), para estudar nos
-- relatórios se vale a pena cobrar antes da 3ª parcela vencida.
-- Lançamentos antigos ficam sem tipo (NULL = "Não informado").
-- Os relatórios ganham o parâmetro p_tipo: NULL = todos | 'Padrão' |
-- 'Antecipada' | 'Não informado'. relatorio_eficacia ganha 'por_tipo'.
-- No banco: 017_tipo_cobranca_coluna (28/10) criou a coluna; 017b_relatorios_tipo_cobranca
-- (29/10) criou o índice e as funções abaixo.
-- =====================================================================
alter table public.lancamentos add column if not exists tipo_cobranca text
  check (tipo_cobranca in ('Padrão','Antecipada'));
create index if not exists lancamentos_tipo_cobranca_idx on public.lancamentos (tipo_cobranca);

drop function if exists public.relatorio(date, date, uuid);
drop function if exists public.relatorio_eficacia(date, date, uuid);

create or replace function public.relatorio(p_inicio date, p_fim date, p_func uuid default null, p_tipo text default null)
 returns jsonb
 language sql
 stable
 set search_path to ''
as $function$
with cat as (
  select l.*,
         case when l.situacao is null then 'Sem situação' else coalesce(s.categoria, 'Outros') end as categoria,
         coalesce(s.novo_acordo, false) as eh_novo_acordo
  from public.lancamentos l
  left join public.situacoes s on s.codigo = l.situacao
  where (p_func is null or l.funcionario_id = p_func)
    and (p_tipo is null or l.tipo_cobranca = p_tipo or (p_tipo = 'Não informado' and l.tipo_cobranca is null))
    and (l.data_contato between p_inicio and p_fim or l.data_pagamento between p_inicio and p_fim)
),
base as (select * from cat where data_contato between p_inicio and p_fim),
pag  as (select * from cat where categoria = 'Pago' and data_pagamento between p_inicio and p_fim)
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
$function$;

create or replace function public.relatorio_eficacia(p_inicio date, p_fim date, p_func uuid default null, p_tipo text default null)
 returns jsonb
 language sql
 stable
 set search_path to ''
as $function$
with base as (
  select l.*,
         case when l.situacao is null then 'Sem situação' else coalesce(s.categoria, 'Outros') end as categoria
  from public.lancamentos l
  left join public.situacoes s on s.codigo = l.situacao
  where (p_func is null or l.funcionario_id = p_func)
    and (p_tipo is null or l.tipo_cobranca = p_tipo or (p_tipo = 'Não informado' and l.tipo_cobranca is null))
    and l.data_contato between p_inicio and p_fim
),
b as (
  select x.*,
         (x.categoria = 'Pago')                                                         as pago,
         coalesce(x.whatsapp = 'Respondido' or x.sms = 'Respondido' or x.ligacao = 'Atendida', false) as respondeu,
         coalesce(x.ligacao = 'Número errado', false) or coalesce(x.whatsapp = 'Sem WhatsApp', false) as contato_falho,
         case when x.categoria = 'Pago' and x.data_pagamento is not null
              then greatest(x.data_pagamento - x.data_contato, 0) end                     as dias_pag,
         coalesce(x.whatsapp in ('Enviado','Respondido','Não respondido'), false) as u_wpp,
         (x.sms is not null)          as u_sms,
         (x.ligacao is not null)      as u_lig,
         (x.agendamento is not null)  as u_age
  from base x
),
m as (
  select b.*, v.meio, v.ordem
  from b cross join lateral (values ('WhatsApp', 1, b.u_wpp), ('SMS', 2, b.u_sms),
                                    ('Ligação', 3, b.u_lig), ('Agendamento', 4, b.u_age)) v(meio, ordem, usado)
  where v.usado
  union all
  select b.*, 'Nenhuma ação registrada', 9 from b where not (b.u_wpp or b.u_sms or b.u_lig or b.u_age)
),
r as (
  select b.*, v.meio, v.ordem, v.resp
  from b cross join lateral (values ('WhatsApp', 1, b.whatsapp), ('SMS', 2, b.sms), ('Ligação', 3, b.ligacao)) v(meio, ordem, resp)
  where v.resp is not null
),
f as (
  select b.*,
         not (b.u_sms or b.u_lig or b.u_age) as so_wpp,
         coalesce(b.u_wpp and (b.meio_acordo = 'WhatsApp' or (b.meio_acordo is null and not (b.u_sms or b.u_lig or b.u_age))), false) as res_wpp
  from b
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
  'por_tipo', (select coalesce(jsonb_agg(x order by x.ordem), '[]'::jsonb) from (
      select coalesce(tipo_cobranca, 'Não informado') as tipo,
             case tipo_cobranca when 'Padrão' then 1 when 'Antecipada' then 2 else 3 end as ordem,
             count(*) as contatos,
             sum(u_wpp::int + u_sms::int + u_lig::int + u_age::int) as acoes,
             count(*) filter (where pago) as pagos,
             count(*) filter (where respondeu) as respondeu,
             count(*) filter (where categoria = 'Em andamento') as andamento,
             count(*) filter (where categoria = 'Revogado') as sem_sucesso,
             coalesce(sum(valor_pago) filter (where pago), 0) as valor,
             round(avg(dias_pag), 1) as dias_medio
      from b group by 1, 2) x),
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
  'funil', jsonb_build_object(
    'resumo', (select jsonb_build_object(
        'contatos', count(*),
        'wpp_enviado', count(*) filter (where u_wpp),
        'wpp_respondeu', count(*) filter (where whatsapp = 'Respondido'),
        'sem_wpp', count(*) filter (where whatsapp = 'Sem WhatsApp'),
        'wpp_nao_informado', count(*) filter (where whatsapp is null),
        'resolvidos_wpp', count(*) filter (where pago and res_wpp),
        'foram_2a', count(*) filter (where not so_wpp),
        'recuperados_2a', count(*) filter (where pago and not res_wpp and not so_wpp),
        'pagos_fora_funil', count(*) filter (where pago and not res_wpp and so_wpp),
        'andamento', count(*) filter (where categoria = 'Em andamento'),
        'sem_sucesso', count(*) filter (where categoria = 'Revogado'),
        'outros', count(*) filter (where categoria in ('Outros','Sem situação')),
        'pagos_so_enviado', count(*) filter (where pago and whatsapp = 'Enviado')) from f),
    'etapa1', (select coalesce(jsonb_agg(x order by x.ordem), '[]'::jsonb) from (
        select coalesce(whatsapp, 'Não informado') as status,
               case whatsapp when 'Respondido' then 1 when 'Enviado' then 2 when 'Não respondido' then 3 when 'Sem WhatsApp' then 4 else 5 end as ordem,
               count(*) as contatos, count(*) filter (where so_wpp) as so_wpp,
               count(*) filter (where pago) as pagos, count(*) filter (where pago and res_wpp) as resolvidos_wpp,
               count(*) filter (where not so_wpp) as foram_2a,
               count(*) filter (where categoria = 'Em andamento') as andamento,
               count(*) filter (where categoria = 'Revogado') as sem_sucesso
        from f group by 1, 2) x),
    'etapa2', (select coalesce(jsonb_agg(x order by x.ordem_wpp, x.ordem), '[]'::jsonb) from (
        select coalesce(f.whatsapp, 'Não informado') as status_wpp,
               case f.whatsapp when 'Respondido' then 1 when 'Enviado' then 2 when 'Não respondido' then 3 when 'Sem WhatsApp' then 4 else 5 end as ordem_wpp,
               v.meio, v.ordem, count(*) as contatos, count(*) filter (where f.pago) as pagos
        from f cross join lateral (values ('SMS', 2, f.u_sms), ('Ligação', 3, f.u_lig), ('Agendamento', 4, f.u_age)) v(meio, ordem, usado)
        where v.usado
        group by 1, 2, 3, 4) x)
  ),
  'meio_acordo', (select coalesce(jsonb_agg(x order by x.acordos desc), '[]'::jsonb) from (
      select meio_acordo as meio, count(*) as acordos, count(*) filter (where pago) as pagos,
             coalesce(sum(valor_pago) filter (where pago), 0) as valor,
             round(avg(dias_pag), 1) as dias_medio
      from b where meio_acordo is not null group by 1) x)
)
$function$;

revoke all on function public.relatorio(date, date, uuid, text) from public, anon;
grant execute on function public.relatorio(date, date, uuid, text) to authenticated;
revoke all on function public.relatorio_eficacia(date, date, uuid, text) from public, anon;
grant execute on function public.relatorio_eficacia(date, date, uuid, text) to authenticated;
