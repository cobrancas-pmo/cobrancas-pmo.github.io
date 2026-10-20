-- =====================================================================
-- COBRANÇAS PMO – Vencimento do boleto e conferência de pagamento
-- Casos com situação que "confere vencimento" (ex.: AGUARDANDO PAGAMENTO)
-- passam a pedir conferência 2 dias úteis após o vencimento do boleto.
-- =====================================================================

alter table public.lancamentos
  add column if not exists boleto_vencimento date;

alter table public.lancamentos
  add constraint lancamentos_vencimento_apos_emissao
  check (boleto_vencimento is null or boleto_emitido is null or boleto_vencimento >= boleto_emitido);

create index if not exists lancamentos_vencimento_idx on public.lancamentos (boleto_vencimento);

alter table public.situacoes
  add column if not exists confere_vencimento boolean not null default false;

update public.situacoes set confere_vencimento = true
 where codigo in ('AGUARDANDO PAGAMENTO', 'AGUARDANDO COMPROVANTE');

update public.situacoes
   set descricao = 'Boleto emitido e ainda dentro do vencimento. Informe a data de vencimento: o sistema avisa para conferir o pagamento 2 dias úteis depois.'
 where codigo = 'AGUARDANDO PAGAMENTO';
