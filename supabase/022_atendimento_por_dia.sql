-- =====================================================================
-- COBRANÇAS PMO – Atendimento de campanha: um por conversa POR DIA (09/11/2026)
-- O CWMKT reaproveita a conversa antiga do contribuinte quando ele aperta o botão
-- da campanha (não abre conversa nova). Por isso o atendimento passa a ser contado
-- uma vez por dia em cada conversa: se o mesmo contribuinte apertar o botão em
-- disparos de dias diferentes, conta um atendimento a cada dia (decidido em 09/11).
-- =====================================================================

alter table public.atendimentos_wa
  add column if not exists dia date
  generated always as ((iniciada_em at time zone 'America/Sao_Paulo')::date) stored;

alter table public.atendimentos_wa drop constraint if exists atendimentos_wa_pkey;
alter table public.atendimentos_wa add constraint atendimentos_wa_pkey primary key (conversa, dia);
