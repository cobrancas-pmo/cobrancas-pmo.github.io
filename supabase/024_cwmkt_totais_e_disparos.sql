-- =====================================================================
-- COBRANÇAS PMO – Cobrança automática: totais do CWMKT e mensagens enviadas (09/11/2026)
-- 1) cwmkt_conversas_dia: quantas mensagens cada conversa do CWMKT teve em cada dia
--    (recebidas do contribuinte e enviadas pela Prefeitura), campanha ou não. Só números:
--    sem texto, sem nome, sem telefone. Serve de base de comparação para a campanha em massa.
--    "Atendimento no CWMKT" = conversa com pelo menos 1 mensagem do contribuinte no dia
--    (uma vez por dia, como os atendimentos de campanha).
--    Quem grava é a função cwmkt (service_role): no aviso de cada mensagem (soma 1) e na
--    recuperação (grava o total do dia, sem diminuir o que já existe).
-- 2) disparos: quantidade de mensagens enviadas em cada disparo em massa, informada à mão
--    pela supervisão/administração, para calcular a taxa de resposta.
-- =====================================================================

create table if not exists public.cwmkt_conversas_dia (
  conversa      bigint not null,
  dia           date not null,
  caixa         integer,
  recebidas     integer not null default 0 check (recebidas >= 0),
  enviadas      integer not null default 0 check (enviadas >= 0),
  atualizado_em timestamptz not null default now(),
  primary key (conversa, dia)
);
create index if not exists cwmkt_conversas_dia_dia_idx on public.cwmkt_conversas_dia (dia);

alter table public.cwmkt_conversas_dia enable row level security;
revoke all on public.cwmkt_conversas_dia from anon, authenticated;

-- aviso de uma mensagem: soma 1 na conversa/dia (dia de Brasília)
create or replace function public.cwmkt_contar(p_conversa bigint, p_quando timestamptz, p_caixa integer, p_entrada boolean)
returns void language sql security definer set search_path to '' as $$
  insert into public.cwmkt_conversas_dia (conversa, dia, caixa, recebidas, enviadas)
  values (p_conversa, (p_quando at time zone 'America/Sao_Paulo')::date, p_caixa,
          case when p_entrada then 1 else 0 end, case when p_entrada then 0 else 1 end)
  on conflict (conversa, dia) do update set
    recebidas = public.cwmkt_conversas_dia.recebidas + excluded.recebidas,
    enviadas  = public.cwmkt_conversas_dia.enviadas + excluded.enviadas,
    caixa     = coalesce(public.cwmkt_conversas_dia.caixa, excluded.caixa),
    atualizado_em = now();
$$;

-- recuperação: total do dia lido do CWMKT (fica o maior valor, para não contar em dobro)
create or replace function public.cwmkt_contar_dia(p_conversa bigint, p_dia date, p_caixa integer, p_recebidas integer, p_enviadas integer)
returns void language sql security definer set search_path to '' as $$
  insert into public.cwmkt_conversas_dia (conversa, dia, caixa, recebidas, enviadas)
  values (p_conversa, p_dia, p_caixa, greatest(p_recebidas, 0), greatest(p_enviadas, 0))
  on conflict (conversa, dia) do update set
    recebidas = greatest(public.cwmkt_conversas_dia.recebidas, excluded.recebidas),
    enviadas  = greatest(public.cwmkt_conversas_dia.enviadas, excluded.enviadas),
    caixa     = coalesce(public.cwmkt_conversas_dia.caixa, excluded.caixa),
    atualizado_em = now();
$$;
revoke all on function public.cwmkt_contar(bigint, timestamptz, integer, boolean) from public, anon, authenticated;
revoke all on function public.cwmkt_contar_dia(bigint, date, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.cwmkt_contar(bigint, timestamptz, integer, boolean) to service_role;
grant execute on function public.cwmkt_contar_dia(bigint, date, integer, integer, integer) to service_role;

-- totais por dia para o relatório (qualquer usuário ativo; só números da equipe toda)
create or replace function public.relatorio_cwmkt(p_ini date, p_fim date)
returns table (dia date, atendimentos integer, recebidas integer, enviadas integer)
language plpgsql stable security definer set search_path to '' as $$
begin
  if not privado.sou_ativo() then raise exception 'Acesso negado'; end if;
  return query
    select c.dia, count(*) filter (where c.recebidas > 0)::int, coalesce(sum(c.recebidas), 0)::int, coalesce(sum(c.enviadas), 0)::int
      from public.cwmkt_conversas_dia c
     where c.dia between p_ini and p_fim
     group by c.dia order by c.dia;
end $$;
revoke all on function public.relatorio_cwmkt(date, date) from public, anon;
grant execute on function public.relatorio_cwmkt(date, date) to authenticated;

-- ---------- Mensagens enviadas nos disparos (informadas à mão)
create table if not exists public.disparos (
  id          bigint generated always as identity primary key,
  data        date not null,
  quantidade  integer not null check (quantidade > 0 and quantidade <= 10000000),
  observacao  text check (char_length(observacao) <= 120),
  criado_por  uuid default auth.uid() references public.perfis(id) on delete set null,
  criado_em   timestamptz not null default now()
);
create index if not exists disparos_data_idx on public.disparos (data);

alter table public.disparos enable row level security;
revoke all on public.disparos from anon, authenticated;
grant select, insert, delete on public.disparos to authenticated;

drop policy if exists disparos_ler on public.disparos;
create policy disparos_ler on public.disparos for select to authenticated
  using ((select privado.sou_ativo()));
drop policy if exists disparos_incluir on public.disparos;
create policy disparos_incluir on public.disparos for insert to authenticated
  with check ((select privado.meu_papel()) in ('supervisor','admin') and criado_por = (select auth.uid()));
drop policy if exists disparos_excluir on public.disparos;
create policy disparos_excluir on public.disparos for delete to authenticated
  using ((select privado.meu_papel()) in ('supervisor','admin'));

drop trigger if exists auditar on public.disparos;
create trigger auditar after insert or update or delete on public.disparos
  for each row execute function public.registrar_auditoria();
