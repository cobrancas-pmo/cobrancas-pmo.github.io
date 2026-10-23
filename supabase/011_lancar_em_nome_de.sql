-- =====================================================================
-- COBRANÇAS PMO – Administrador lança em nome de outro atendente (23/10/2026)
-- * Política de inclusão: o próprio usuário ativo (como antes) OU o administrador
--   em nome de um atendente ATIVO.
-- * Nova coluna criado_por: quem de fato digitou o lançamento (fixa após a inclusão).
--   A auditoria também registra o usuário que fez a inclusão.
-- * Continua proibido transferir um lançamento existente para outro funcionário.
-- =====================================================================

alter table public.lancamentos add column if not exists criado_por uuid references public.perfis(id);
update public.lancamentos set criado_por = funcionario_id where criado_por is null;

alter policy lanc_inserir on public.lancamentos
  with check (((funcionario_id = (select auth.uid())) and (select privado.sou_ativo()))
              or ((select privado.meu_papel()) = 'admin'));

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
    new.criado_por := old.criado_por;
    if not v_gestor then
      new.cancelamento_status        := old.cancelamento_status;
      new.cancelamento_lote          := old.cancelamento_lote;
      new.cancelamento_obs           := old.cancelamento_obs;
      new.cancelamento_atualizado_em := old.cancelamento_atualizado_em;
    end if;
  else
    -- inclusão: quem digitou fica registrado; em nome de outro, só administrador e para atendente ativo
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

  select s.gera_cancelamento, s.categoria into v_gera, v_cat from public.situacoes s where s.codigo = new.situacao;

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
