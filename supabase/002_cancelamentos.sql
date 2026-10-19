-- =====================================================================
-- COBRANÇAS PMO – Fila de cancelamento e relatório semanal (lotes)
-- Casos com situação que "gera cancelamento" entram na fila; um supervisor
-- gera o lote semanal enviado à Recuperação de Ativos e acompanha o retorno.
-- =====================================================================

alter table public.situacoes add column if not exists gera_cancelamento boolean not null default false;

create table if not exists public.lotes_cancelamento (
  id          bigint generated always as identity primary key,
  numero      text not null unique,
  ano         int not null,
  data_envio  date not null,
  quantidade  int not null,
  observacao  text check (char_length(observacao) <= 500),
  criado_por  uuid references public.perfis(id),
  criado_em   timestamptz not null default now()
);
create index if not exists lotes_cancelamento_criado_por_idx on public.lotes_cancelamento (criado_por);

alter table public.lancamentos
  add column if not exists cancelamento_status text
    check (cancelamento_status in ('Aguardando envio','Retirado','Enviado','Cancelado','Devolvido')),
  add column if not exists cancelamento_lote bigint references public.lotes_cancelamento(id),
  add column if not exists cancelamento_obs text check (char_length(cancelamento_obs) <= 300),
  add column if not exists cancelamento_atualizado_em timestamptz;
create index if not exists lancamentos_canc_status_idx on public.lancamentos (cancelamento_status);
create index if not exists lancamentos_canc_lote_idx on public.lancamentos (cancelamento_lote);

-- Segurança da tabela de lotes
alter table public.lotes_cancelamento enable row level security;
revoke all on public.lotes_cancelamento from anon, authenticated;
grant select on public.lotes_cancelamento to authenticated;
create policy lotes_ler on public.lotes_cancelamento for select to authenticated
  using ((select privado.sou_ativo()));
create trigger auditar after insert or update or delete on public.lotes_cancelamento
  for each row execute function public.registrar_auditoria();

-- Gatilho dos lançamentos: protege campos de cancelamento e alimenta a fila
create or replace function public.lancamento_antes_gravar() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_gera   boolean;
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

  select s.gera_cancelamento into v_gera from public.situacoes s where s.codigo = new.situacao;
  if coalesce(v_gera, false) then
    if new.cancelamento_status is null then
      new.cancelamento_status := 'Aguardando envio';
      new.cancelamento_atualizado_em := now();
    end if;
  elsif new.cancelamento_status in ('Aguardando envio','Retirado') and new.cancelamento_lote is null then
    new.cancelamento_status := null;
    new.cancelamento_atualizado_em := now();
  end if;

  new.atualizado_em := now();
  new.atualizado_por := auth.uid();
  return new;
end $$;
revoke all on function public.lancamento_antes_gravar() from public, anon, authenticated;

-- Gera o lote semanal (somente supervisão/admin)
create or replace function public.gerar_lote_cancelamento(p_ids bigint[] default null, p_obs text default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_lote bigint; v_num text; v_qtd int;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ano  int  := extract(year from (now() at time zone 'America/Sao_Paulo'))::int;
begin
  if coalesce(privado.meu_papel(), '') not in ('supervisor','admin') then
    raise exception 'Somente a supervisão pode gerar o relatório de cancelamento';
  end if;
  lock table public.lotes_cancelamento in share row exclusive mode;
  select count(*) into v_qtd from public.lancamentos
   where cancelamento_status = 'Aguardando envio' and (p_ids is null or id = any(p_ids));
  if v_qtd = 0 then raise exception 'Não há casos aguardando envio'; end if;
  select v_ano::text || '/' || lpad((count(*) + 1)::text, 3, '0') into v_num
    from public.lotes_cancelamento where ano = v_ano;
  insert into public.lotes_cancelamento (numero, ano, data_envio, quantidade, observacao, criado_por)
  values (v_num, v_ano, v_hoje, v_qtd, nullif(trim(p_obs), ''), auth.uid())
  returning id into v_lote;
  update public.lancamentos
     set cancelamento_status = 'Enviado', cancelamento_lote = v_lote, cancelamento_atualizado_em = now()
   where cancelamento_status = 'Aguardando envio' and (p_ids is null or id = any(p_ids));
  return v_lote;
end $$;
revoke all on function public.gerar_lote_cancelamento(bigint[], text) from public, anon;
grant execute on function public.gerar_lote_cancelamento(bigint[], text) to authenticated;

-- Atualiza o andamento de um caso (somente supervisão/admin)
create or replace function public.atualizar_cancelamento(p_id bigint, p_status text, p_obs text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(privado.meu_papel(), '') not in ('supervisor','admin') then
    raise exception 'Somente a supervisão pode alterar o andamento do cancelamento';
  end if;
  update public.lancamentos
     set cancelamento_status = p_status, cancelamento_obs = nullif(trim(p_obs), ''), cancelamento_atualizado_em = now()
   where id = p_id
     and ((cancelamento_lote is null and p_status in ('Aguardando envio','Retirado'))
       or (cancelamento_lote is not null and p_status in ('Enviado','Cancelado','Devolvido')));
  if not found then raise exception 'Alteração não permitida para este caso'; end if;
end $$;
revoke all on function public.atualizar_cancelamento(bigint, text, text) from public, anon;
grant execute on function public.atualizar_cancelamento(bigint, text, text) to authenticated;

-- Relatório: inclui os números de cancelamento
create or replace function public.relatorio(p_inicio date, p_fim date, p_func uuid default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
with base as (
  select l.*,
         case when l.situacao is null then 'Sem situação' else coalesce(s.categoria, 'Outros') end as categoria
  from public.lancamentos l
  left join public.situacoes s on s.codigo = l.situacao
  where l.data_contato between p_inicio and p_fim
    and (p_func is null or l.funcionario_id = p_func)
)
select jsonb_build_object(
  'totais', (select jsonb_build_object(
      'contatos',     count(*),
      'whatsapp',     count(*) filter (where whatsapp in ('Enviado','Respondido')),
      'sms',          count(sms),
      'ligacoes',     count(ligacao),
      'agendamentos', count(agendamento),
      'boletos',      count(boleto_emitido),
      'pagos',        count(*) filter (where categoria = 'Pago'),
      'andamento',    count(*) filter (where categoria = 'Em andamento'),
      'revogados',    count(*) filter (where categoria = 'Revogado'),
      'outros',       count(*) filter (where categoria = 'Outros'),
      'sem_situacao', count(*) filter (where categoria = 'Sem situação'),
      'valor',        coalesce(sum(valor_pago) filter (where categoria = 'Pago'), 0),
      'parcelas',     coalesce(sum(parcelas) filter (where categoria = 'Pago'), 0),
      'dias',         count(distinct (funcionario_id, data_contato)),
      'funcionarios', count(distinct funcionario_id),
      'pago_sem_valor', count(*) filter (where categoria = 'Pago' and valor_pago is null),
      'canc_aguardando', count(*) filter (where cancelamento_status = 'Aguardando envio'),
      'canc_enviados',   count(*) filter (where cancelamento_status in ('Enviado','Cancelado','Devolvido')),
      'canc_cancelados', count(*) filter (where cancelamento_status = 'Cancelado'),
      'canc_devolvidos', count(*) filter (where cancelamento_status = 'Devolvido')
    ) from base),
  'por_dia', (select coalesce(jsonb_agg(x order by x.dia), '[]'::jsonb) from (
      select data_contato as dia, count(*) as contatos, count(boleto_emitido) as boletos,
             count(*) filter (where categoria = 'Pago') as pagos,
             coalesce(sum(valor_pago) filter (where categoria = 'Pago'), 0) as valor
      from base group by data_contato) x),
  'por_mes', (select coalesce(jsonb_agg(x order by x.mes), '[]'::jsonb) from (
      select to_char(date_trunc('month', data_contato), 'YYYY-MM') as mes, count(*) as contatos,
             count(boleto_emitido) as boletos, count(*) filter (where categoria = 'Pago') as pagos,
             count(*) filter (where categoria = 'Revogado') as revogados,
             coalesce(sum(valor_pago) filter (where categoria = 'Pago'), 0) as valor
      from base group by 1) x),
  'por_categoria', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select categoria, count(*) as qtde from base group by categoria) x),
  'por_situacao', (select coalesce(jsonb_agg(x order by x.ordem, x.situacao), '[]'::jsonb) from (
      select s.codigo as situacao, s.categoria, s.ordem, count(b.id) as qtde
      from public.situacoes s left join base b on b.situacao = s.codigo
      group by s.codigo, s.categoria, s.ordem) x),
  'por_setor', (select coalesce(jsonb_agg(x order by x.contatos desc), '[]'::jsonb) from (
      select coalesce(setor, '(não informado)') as setor, count(*) as contatos,
             count(*) filter (where categoria = 'Pago') as pagos,
             coalesce(sum(valor_pago) filter (where categoria = 'Pago'), 0) as valor
      from base group by 1) x),
  'por_funcionario', (select coalesce(jsonb_agg(x order by x.valor desc), '[]'::jsonb) from (
      select b.funcionario_id as id, coalesce(p.nome, '—') as nome, count(*) as contatos,
             count(boleto_emitido) as boletos,
             count(*) filter (where categoria = 'Pago') as pagos,
             count(*) filter (where categoria = 'Em andamento') as andamento,
             count(*) filter (where categoria = 'Revogado') as revogados,
             coalesce(sum(valor_pago) filter (where categoria = 'Pago'), 0) as valor,
             count(distinct data_contato) as dias
      from base b left join public.perfis p on p.id = b.funcionario_id
      group by b.funcionario_id, p.nome) x)
)
$$;
revoke all on function public.relatorio(date, date, uuid) from public, anon;
grant execute on function public.relatorio(date, date, uuid) to authenticated;

-- Nova situação
insert into public.situacoes (codigo, categoria, descricao, ordem, gera_cancelamento) values
 ('ENVIAR PARA CANCELAMENTO', 'Revogado',
  'Sem possibilidade de renegociação: o caso entra na fila do relatório semanal (quintas-feiras) enviado à Recuperação de Ativos para cancelamento do parcelamento.',
  37, true)
on conflict (codigo) do update set gera_cancelamento = true;
