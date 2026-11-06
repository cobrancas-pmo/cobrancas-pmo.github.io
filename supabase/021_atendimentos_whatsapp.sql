-- =====================================================================
-- COBRANÇAS PMO – Atendimentos de campanha no WhatsApp (CWMKT) (06/11/2026)
-- O disparo em massa agora é feito por outro sistema. O contribuinte responde
-- apertando um botão ("Pagar Agora com desconto!", "Quero Parcelar!") e a conversa
-- nasce no CWMKT. A cobrança manual começa com a mensagem pronta "Prezado
-- Contribuinte: Tributo: …" enviada pelo atendente.
-- A função "cwmkt" reconhece esses inícios pelas frases abaixo, guarda a conversa
-- e o PRIMEIRO agente atribuído. Não cria lançamento (só relatório).
-- Nada de conteúdo de mensagem nem telefone é guardado.
-- =====================================================================

-- ---------- Frases que marcam o início do atendimento (editáveis em Administração)
create table if not exists public.atendimento_frases (
  id        bigint generated always as identity primary key,
  frase     text not null unique check (char_length(btrim(frase)) between 3 and 200),
  gatilho   text not null check (char_length(btrim(gatilho)) between 2 and 40),   -- coluna do relatório
  quem      text not null check (quem in ('contribuinte','atendente')),            -- quem manda a frase
  ativo     boolean not null default true,
  criado_em timestamptz not null default now()
);
insert into public.atendimento_frases (frase, gatilho, quem) values
  ('Pagar Agora com desconto!', 'Pagar agora', 'contribuinte'),
  ('Quero Parcelar!', 'Quero parcelar', 'contribuinte'),
  ('Prezado Contribuinte: Tributo:', 'Cobrança manual', 'atendente')
on conflict (frase) do nothing;

-- ---------- Atendimentos (um por conversa do CWMKT)
create table if not exists public.atendimentos_wa (
  conversa      bigint primary key,                       -- nº da conversa no CWMKT
  gatilho       text not null,                            -- Pagar agora | Quero parcelar | Cobrança manual | …
  iniciada_em   timestamptz not null,                     -- hora da frase que abriu o atendimento
  caixa         integer,
  agente_id     integer,                                  -- 1º agente atribuído (CWMKT)
  agente_nome   text check (char_length(agente_nome) <= 120),
  agente_email  text check (char_length(agente_email) <= 200),
  usuario_id    uuid references public.perfis(id) on delete set null,   -- se o agente tem login no sistema
  atribuido_em  timestamptz,
  etiqueta      boolean not null default false,           -- etiqueta "campanha" colocada
  origem        text not null default 'aviso' check (origem in ('aviso','importacao')),
  link          text check (char_length(link) <= 300),    -- endereço da conversa no CWMKT
  criado_em     timestamptz not null default now()
);
create index if not exists atendimentos_wa_iniciada_idx on public.atendimentos_wa (iniciada_em);
create index if not exists atendimentos_wa_usuario_idx on public.atendimentos_wa (usuario_id);

-- agente do CWMKT → usuário do sistema, sem chutar pelo primeiro nome:
-- e-mail igual → nome completo igual → todas as palavras do nome do agente (2 ou mais) no nome do usuário
create or replace function privado.usuario_do_agente(p_email text, p_nome text) returns uuid
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
  if array_length(w, 1) < 2 then return null; end if;
  select count(*), min(id::text)::uuid into c, v from public.perfis p
   where p.ativo and string_to_array(privado.norm_nome(p.nome), ' ') @> w;
  return case when c = 1 then v end;
end $$;
revoke all on function privado.usuario_do_agente(text, text) from public, anon, authenticated;

create or replace function privado.atendimento_wa_usuario() returns trigger
language plpgsql set search_path to '' as $$
begin
  if new.agente_nome is distinct from coalesce(case when tg_op = 'UPDATE' then old.agente_nome end, '')
     or new.agente_email is distinct from coalesce(case when tg_op = 'UPDATE' then old.agente_email end, '') then
    new.usuario_id := privado.usuario_do_agente(new.agente_email, new.agente_nome);
  end if;
  return new;
end $$;
drop trigger if exists usuario on public.atendimentos_wa;
create trigger usuario before insert or update on public.atendimentos_wa
  for each row execute function privado.atendimento_wa_usuario();

-- ---------- Acesso: só leitura pelo site; quem grava é a função cwmkt (service_role)
alter table public.atendimentos_wa enable row level security;
alter table public.atendimento_frases enable row level security;
revoke all on public.atendimentos_wa, public.atendimento_frases from anon, authenticated;
grant select on public.atendimentos_wa to authenticated;
grant select, insert, update, delete on public.atendimento_frases to authenticated;

drop policy if exists atend_wa_ler on public.atendimentos_wa;
create policy atend_wa_ler on public.atendimentos_wa for select to authenticated
  using ((usuario_id = (select auth.uid()) and (select privado.sou_ativo()))
         or (select privado.meu_papel()) in ('supervisor','admin'));

drop policy if exists frases_ler on public.atendimento_frases;
create policy frases_ler on public.atendimento_frases for select to authenticated
  using ((select privado.sou_ativo()));
drop policy if exists frases_admin_ins on public.atendimento_frases;
create policy frases_admin_ins on public.atendimento_frases for insert to authenticated
  with check ((select privado.meu_papel()) = 'admin');
drop policy if exists frases_admin_upd on public.atendimento_frases;
create policy frases_admin_upd on public.atendimento_frases for update to authenticated
  using ((select privado.meu_papel()) = 'admin') with check ((select privado.meu_papel()) = 'admin');
drop policy if exists frases_admin_del on public.atendimento_frases;
create policy frases_admin_del on public.atendimento_frases for delete to authenticated
  using ((select privado.meu_papel()) = 'admin');

drop trigger if exists auditar on public.atendimento_frases;
create trigger auditar after insert or update or delete on public.atendimento_frases
  for each row execute function public.registrar_auditoria();
