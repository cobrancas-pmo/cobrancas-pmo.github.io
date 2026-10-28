-- =====================================================================
-- COBRANÇAS PMO – Resposta em massa da Recuperação de Ativos (28/10/2026)
-- Registra a mesma resposta ("Cancelado" = acordo revogado, ou "Devolvido" =
-- não revogado) para vários casos já enviados, numa única operação.
-- Mesmas regras da função individual: só supervisão/administração e só casos
-- com lote e ainda "Enviado". Devolve quantos casos foram atualizados.
-- =====================================================================
create or replace function public.atualizar_cancelamento_varios(p_ids bigint[], p_status text, p_obs text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_qtd integer;
begin
  if coalesce(privado.meu_papel(), '') not in ('supervisor','admin') then
    raise exception 'Somente a supervisão pode alterar o andamento do cancelamento';
  end if;
  if p_status not in ('Cancelado','Devolvido') then
    raise exception 'Resposta inválida';
  end if;
  update public.lancamentos
     set cancelamento_status = p_status, cancelamento_obs = nullif(trim(p_obs), ''), cancelamento_atualizado_em = now()
   where id = any(p_ids)
     and cancelamento_lote is not null
     and cancelamento_status = 'Enviado';
  get diagnostics v_qtd = row_count;
  if v_qtd = 0 then raise exception 'Nenhum caso aguardando resposta foi encontrado'; end if;
  return v_qtd;
end $$;
revoke all on function public.atualizar_cancelamento_varios(bigint[], text, text) from public, anon;
grant execute on function public.atualizar_cancelamento_varios(bigint[], text, text) to authenticated;
