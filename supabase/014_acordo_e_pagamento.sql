-- =====================================================================
-- COBRANÇAS PMO – Seção "Acordo e pagamento" (23/10/2026)
-- * tipo_acordo: 'Boleto' ou 'Novo parcelamento' (nulo = nenhum).
--   Os campos boleto_emitido / boleto_vencimento / valor_boleto / parcelas servem aos
--   dois tipos (no novo parcelamento: dados da 1ª parcela/entrada e nº de parcelas do acordo).
--   valor_acordo e novo_parcelamento só existem no tipo "Novo parcelamento".
-- * Situação marcada como "Novo acordo" define o tipo automaticamente.
-- =====================================================================

alter table public.lancamentos add column if not exists tipo_acordo text
  check (tipo_acordo in ('Boleto','Novo parcelamento'));

update public.lancamentos l set tipo_acordo = 'Novo parcelamento'
 where tipo_acordo is null
   and (valor_acordo is not null or novo_parcelamento is not null
        or situacao in (select codigo from public.situacoes where novo_acordo));
update public.lancamentos set tipo_acordo = 'Boleto'
 where tipo_acordo is null
   and (boleto_emitido is not null or boleto_vencimento is not null or valor_boleto is not null);

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

  -- situação de novo parcelamento implica tipo de acordo "Novo parcelamento"
  if coalesce(v_novo, false) and new.tipo_acordo is null then
    new.tipo_acordo := 'Novo parcelamento';
  end if;
  -- valor total e nº do novo acordo só existem quando o tipo de acordo é "Novo parcelamento"
  if new.tipo_acordo is distinct from 'Novo parcelamento' then
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
