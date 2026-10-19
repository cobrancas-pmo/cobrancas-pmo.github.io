-- =====================================================================
-- COBRANÇAS PMO – estrutura do banco (Supabase / PostgreSQL)
-- Sem dados pessoais: não há nome nem telefone do contribuinte.
-- =====================================================================

-- ---------- Perfis dos usuários (funcionários) ----------
create table public.perfis (
  id        uuid primary key references auth.users(id) on delete cascade,
  nome      text not null check (char_length(nome) between 2 and 80),
  email     text,
  papel     text not null default 'funcionario' check (papel in ('funcionario','supervisor','admin')),
  ativo     boolean not null default false,          -- só entra depois de aprovado pelo admin
  criado_em timestamptz not null default now()
);

-- ---------- Tabelas de padronização ----------
create table public.situacoes (
  codigo    text primary key check (char_length(codigo) between 3 and 60),
  categoria text not null check (categoria in ('Pago','Em andamento','Revogado','Outros')),
  descricao text,
  ordem     int not null default 100,
  ativo     boolean not null default true
);

create table public.setores (
  nome  text primary key check (char_length(nome) between 2 and 40),
  ordem int not null default 100,
  ativo boolean not null default true
);

-- ---------- Lançamentos (um por contribuinte contatado) ----------
create table public.lancamentos (
  id               bigint generated always as identity primary key,
  funcionario_id   uuid not null default auth.uid() references public.perfis(id),
  data_contato     date not null default ((now() at time zone 'America/Sao_Paulo')::date),
  id_parcelamento  text not null check (id_parcelamento ~ '^[0-9A-Za-z./-]{1,30}$'),
  setor            text references public.setores(nome) on update cascade,
  origem           text check (origem ~ '^[0-9A-Za-z./-]{1,30}$'),
  fonte_contato    text check (fonte_contato in ('Cadastro','Localize','Assertiva','Informado pelo contribuinte')),
  whatsapp         text check (whatsapp in ('Enviado','Respondido','Sem WhatsApp')),
  sms              text check (sms in ('Enviado','Respondido')),
  ligacao          text check (ligacao in ('Atendida','Não atendida','Número errado')),
  agendamento      date,
  boleto_emitido   date,
  parcelas         int check (parcelas between 1 and 240),
  situacao         text references public.situacoes(codigo) on update cascade,
  valor_pago       numeric(12,2) check (valor_pago >= 0),
  observacoes      text check (char_length(observacoes) <= 500),
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now(),
  atualizado_por   uuid default auth.uid()
);
create index lancamentos_func_data_idx on public.lancamentos (funcionario_id, data_contato);
create index lancamentos_data_idx on public.lancamentos (data_contato);
create index lancamentos_parc_idx on public.lancamentos (id_parcelamento);
create index lancamentos_situacao_idx on public.lancamentos (situacao);
create index lancamentos_setor_idx on public.lancamentos (setor);

-- ---------- Auditoria (quem criou/alterou/excluiu o quê) ----------
create table public.auditoria (
  id        bigint generated always as identity primary key,
  tabela    text not null,
  registro  text,
  acao      text not null,
  usuario   uuid,
  quando    timestamptz not null default now(),
  antes     jsonb,
  depois    jsonb
);
create index auditoria_quando_idx on public.auditoria (quando);

-- =====================================================================
-- Funções auxiliares (security definer, com search_path vazio)
-- Ficam no esquema "privado", que não é exposto pela API.
-- =====================================================================
create schema if not exists privado;
revoke all on schema privado from public, anon;
grant usage on schema privado to authenticated;
create or replace function privado.meu_papel() returns text
language sql stable security definer set search_path = '' as $$
  select p.papel from public.perfis p where p.id = auth.uid() and p.ativo
$$;

create or replace function privado.sou_ativo() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.perfis p where p.id = auth.uid() and p.ativo)
$$;

-- Cria o perfil (inativo) quando alguém se cadastra
create or replace function public.novo_usuario() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.perfis (id, nome, email)
  values (new.id,
          left(coalesce(nullif(trim(new.raw_user_meta_data->>'nome'), ''), split_part(new.email, '@', 1)), 80),
          new.email);
  return new;
end $$;
create trigger ao_criar_usuario after insert on auth.users
  for each row execute function public.novo_usuario();

-- Carimbo de atualização e proteção do dono do registro
create or replace function public.lancamento_antes_gravar() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.funcionario_id <> old.funcionario_id then
      raise exception 'Não é permitido transferir o lançamento para outro funcionário';
    end if;
    new.criado_em := old.criado_em;
  end if;
  new.atualizado_em := now();
  new.atualizado_por := auth.uid();
  return new;
end $$;
create trigger lancamento_antes_gravar before insert or update on public.lancamentos
  for each row execute function public.lancamento_antes_gravar();

-- Grava auditoria
create or replace function public.registrar_auditoria() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.auditoria (tabela, registro, acao, usuario, antes, depois)
  values (tg_table_name,
          coalesce((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end)->>'id',
                   (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end)->>'codigo',
                   (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end)->>'nome'),
          tg_op, auth.uid(),
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;
create trigger auditar after insert or update or delete on public.lancamentos
  for each row execute function public.registrar_auditoria();
create trigger auditar after update or delete on public.perfis
  for each row execute function public.registrar_auditoria();
create trigger auditar after insert or update or delete on public.situacoes
  for each row execute function public.registrar_auditoria();

-- Impede que o usuário mude o próprio papel/ativo (só admin muda)
create or replace function public.perfil_antes_atualizar() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- auth.uid() nulo = painel/SQL do Supabase (dono do projeto); usuários do site sempre têm uid
  if auth.uid() is not null and coalesce(privado.meu_papel(), '') <> 'admin' then
    if new.papel <> old.papel or new.ativo <> old.ativo or new.id <> old.id or new.email is distinct from old.email then
      raise exception 'Somente o administrador pode alterar papel ou acesso';
    end if;
  end if;
  return new;
end $$;
create trigger perfil_antes_atualizar before update on public.perfis
  for each row execute function public.perfil_antes_atualizar();

-- =====================================================================
-- Segurança: RLS + privilégios mínimos
-- =====================================================================
alter table public.perfis      enable row level security;
alter table public.situacoes   enable row level security;
alter table public.setores     enable row level security;
alter table public.lancamentos enable row level security;
alter table public.auditoria   enable row level security;

-- Visitante sem login (anon) não acessa nada
revoke all on public.perfis, public.situacoes, public.setores, public.lancamentos, public.auditoria from anon;
revoke all on public.perfis, public.situacoes, public.setores, public.lancamentos, public.auditoria from authenticated;
grant select, update on public.perfis to authenticated;
grant select, insert, update on public.situacoes, public.setores to authenticated;
grant select, insert, update, delete on public.lancamentos to authenticated;
grant select on public.auditoria to authenticated;

-- perfis
create policy perfis_ler on public.perfis for select to authenticated
  using (id = (select auth.uid()) or (select privado.meu_papel()) in ('supervisor','admin'));
create policy perfis_editar_proprio on public.perfis for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy perfis_admin on public.perfis for update to authenticated
  using ((select privado.meu_papel()) = 'admin') with check ((select privado.meu_papel()) = 'admin');

-- situacoes / setores: todos os ativos leem; só admin altera
create policy situacoes_ler on public.situacoes for select to authenticated using ((select privado.sou_ativo()));
create policy situacoes_admin_ins on public.situacoes for insert to authenticated with check ((select privado.meu_papel()) = 'admin');
create policy situacoes_admin_upd on public.situacoes for update to authenticated
  using ((select privado.meu_papel()) = 'admin') with check ((select privado.meu_papel()) = 'admin');
create policy setores_ler on public.setores for select to authenticated using ((select privado.sou_ativo()));
create policy setores_admin_ins on public.setores for insert to authenticated with check ((select privado.meu_papel()) = 'admin');
create policy setores_admin_upd on public.setores for update to authenticated
  using ((select privado.meu_papel()) = 'admin') with check ((select privado.meu_papel()) = 'admin');

-- lancamentos: cada um os seus; supervisor/admin leem todos; admin corrige
create policy lanc_ler on public.lancamentos for select to authenticated
  using ((funcionario_id = (select auth.uid()) and (select privado.sou_ativo()))
         or (select privado.meu_papel()) in ('supervisor','admin'));
create policy lanc_inserir on public.lancamentos for insert to authenticated
  with check (funcionario_id = (select auth.uid()) and (select privado.sou_ativo()));
create policy lanc_editar on public.lancamentos for update to authenticated
  using ((funcionario_id = (select auth.uid()) and (select privado.sou_ativo())) or (select privado.meu_papel()) = 'admin')
  with check ((funcionario_id = (select auth.uid()) and (select privado.sou_ativo())) or (select privado.meu_papel()) = 'admin');
create policy lanc_excluir on public.lancamentos for delete to authenticated
  using ((funcionario_id = (select auth.uid()) and (select privado.sou_ativo())) or (select privado.meu_papel()) = 'admin');

-- auditoria: só admin lê; ninguém grava direto (só pelos gatilhos)
create policy auditoria_ler on public.auditoria for select to authenticated
  using ((select privado.meu_papel()) = 'admin');

-- =====================================================================
-- Relatório (respeita o RLS: security invoker)
-- =====================================================================
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
      'pago_sem_valor', count(*) filter (where categoria = 'Pago' and valor_pago is null)
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
revoke all on function privado.meu_papel(), privado.sou_ativo() from public, anon;
grant execute on function privado.meu_papel(), privado.sou_ativo() to authenticated;
revoke all on function public.novo_usuario() from public, anon, authenticated;
revoke all on function public.registrar_auditoria() from public, anon, authenticated;
revoke all on function public.perfil_antes_atualizar() from public, anon, authenticated;
revoke all on function public.lancamento_antes_gravar() from public, anon, authenticated;

-- =====================================================================
-- Dados iniciais de padronização
-- =====================================================================
insert into public.situacoes (codigo, categoria, descricao, ordem) values
 ('BOLETO PAGO','Pago','Pagamento confirmado. Informe data do boleto, nº de parcelas e valor pago.',10),
 ('AGUARDANDO RESPOSTA','Em andamento','Mensagem/SMS enviado; aguardando retorno (24 h) ou prazo pedido pelo contribuinte.',20),
 ('AGUARDANDO PAGAMENTO','Em andamento','Boleto emitido e ainda dentro do vencimento.',21),
 ('AGUARDANDO COMPROVANTE','Em andamento','Contribuinte informou que pagou; falta comprovante ou baixa no sistema.',22),
 ('ATENDIMENTO AGENDADO','Em andamento','Comparecimento agendado (informe a data do agendamento).',23),
 ('PESQUISAR OUTRO CONTATO','Em andamento','Número errado; buscar outro telefone (Localize/Assertiva).',24),
 ('REVOGADO – SEM RESPOSTA','Revogado','Esgotados todos os meios (WhatsApp, SMS, ligação) sem retorno.',30),
 ('REVOGADO – COBRANÇA NÃO RESPONDIDA','Revogado','Respondeu, mas não demonstrou interesse.',31),
 ('REVOGADO – NÃO ENCONTRADO','Revogado','Telefone incorreto e nenhum outro número localizado.',32),
 ('REVOGADO – BOLETO NÃO PAGO','Revogado','Boleto emitido e vencido sem pagamento.',33),
 ('REVOGADO – NÃO COMPARECEU','Revogado','Não compareceu ao atendimento agendado.',34),
 ('REVOGADO – SEM RECURSOS','Revogado','Declarou não ter condições de pagar.',35),
 ('REVOGADO – DESEJA REPARCELAR','Revogado','Optou por fazer novo parcelamento.',36),
 ('ORIENTADO SOBRE CANCELAMENTO','Outros','Parcelas em aberto; contribuinte orientado sobre o cancelamento.',40);

insert into public.setores (nome, ordem) values
 ('Imobiliário',1),('Mobiliário',2),('CRC',3),('Contribuinte',4),('Outros',9);
