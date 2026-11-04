-- =====================================================================
-- COBRANÇAS PMO – Ligação com o CWMKT (WhatsApp da Prefeitura) (04/11/2026)
-- A função "cwmkt" (Edge Function) recebe os avisos do CWMKT e chama
-- cwmkt_registrar: reconhece o contribuinte da campanha pelo telefone
-- embaralhado, grava quando o cobrador mandou o 1º WhatsApp e quando o
-- contribuinte respondeu, e marca o WhatsApp no lançamento.
-- Nada de conteúdo de mensagem nem telefone é guardado.
-- =====================================================================
alter table public.campanha_itens add column if not exists cwmkt_conversa bigint;
alter table public.campanha_itens add column if not exists cwmkt_atribuida_em timestamptz;
create index if not exists campanha_itens_conversa_idx on public.campanha_itens (cwmkt_conversa) where cwmkt_conversa is not null;

-- Registro dos avisos recebidos (para conferência; sem dados pessoais). Mantém 60 dias.
create table if not exists public.cwmkt_eventos (
  id         bigint generated always as identity primary key,
  recebido   timestamptz not null default now(),
  evento     text,
  conversa   bigint,
  resultado  text check (char_length(resultado) <= 300)
);
create index if not exists cwmkt_eventos_recebido_idx on public.cwmkt_eventos (recebido);
alter table public.cwmkt_eventos enable row level security;
revoke all on public.cwmkt_eventos from anon, authenticated;
grant select on public.cwmkt_eventos to authenticated;
drop policy if exists cwmkt_eventos_ler on public.cwmkt_eventos;
create policy cwmkt_eventos_ler on public.cwmkt_eventos for select to authenticated
  using ((select privado.meu_papel()) = 'admin');

-- p_hashes: variantes do telefone embaralhado (com e sem o 9);
-- p_tipo: 'entrada' (contribuinte escreveu) | 'saida' (cobrador escreveu) | 'abertura' (bot passou para humano)
-- Devolve o item da campanha mais recente (últimos 30 dias) com o cobrador, ou nulo.
create or replace function public.cwmkt_registrar(p_hashes text[], p_tipo text, p_quando timestamptz, p_conversa bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if p_tipo not in ('entrada','saida','abertura') then raise exception 'tipo inválido'; end if;
  select i.id, i.campanha_id, i.lancamento_id, i.retorno_em, i.wa_enviado_em, i.cwmkt_atribuida_em,
         c.codigo, c.funcionario_id, p.nome, p.email
    into r
    from public.campanha_itens i
    join public.campanhas c on c.id = i.campanha_id
    join public.perfis p on p.id = c.funcionario_id
   where (i.telefone_hash = any(p_hashes) or (p_conversa is not null and i.cwmkt_conversa = p_conversa))
     and c.data_envio >= ((now() at time zone 'America/Sao_Paulo')::date - 30)
   order by c.data_envio desc, i.id desc
   limit 1;
  if r.id is null then return null; end if;

  -- todos os parcelamentos do mesmo contribuinte nessa campanha recebem a marcação
  update public.campanha_itens i
     set cwmkt_conversa = coalesce(p_conversa, i.cwmkt_conversa),
         retorno_em     = case when p_tipo = 'entrada' then coalesce(i.retorno_em, p_quando) else i.retorno_em end,
         wa_enviado_em  = case when p_tipo = 'saida'   then coalesce(i.wa_enviado_em, p_quando) else i.wa_enviado_em end
   where i.campanha_id = r.campanha_id
     and (i.telefone_hash = any(p_hashes) or i.id = r.id);

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
                            'nome', r.nome, 'email', r.email, 'ja_atribuida', r.cwmkt_atribuida_em is not null);
end $$;
revoke all on function public.cwmkt_registrar(text[], text, timestamptz, bigint) from public, anon, authenticated;
grant execute on function public.cwmkt_registrar(text[], text, timestamptz, bigint) to service_role;

create or replace function public.cwmkt_marcar_atribuida(p_conversa bigint)
returns void language sql security definer set search_path = '' as $$
  update public.campanha_itens set cwmkt_atribuida_em = now() where cwmkt_conversa = p_conversa and cwmkt_atribuida_em is null
$$;
revoke all on function public.cwmkt_marcar_atribuida(bigint) from public, anon, authenticated;
grant execute on function public.cwmkt_marcar_atribuida(bigint) to service_role;

create or replace function public.cwmkt_log(p_evento text, p_conversa bigint, p_resultado text)
returns void language sql security definer set search_path = '' as $$
  delete from public.cwmkt_eventos where recebido < now() - interval '60 days';
  insert into public.cwmkt_eventos (evento, conversa, resultado) values (left(p_evento, 60), p_conversa, left(p_resultado, 300));
$$;
revoke all on function public.cwmkt_log(text, bigint, text) from public, anon, authenticated;
grant execute on function public.cwmkt_log(text, bigint, text) to service_role;
