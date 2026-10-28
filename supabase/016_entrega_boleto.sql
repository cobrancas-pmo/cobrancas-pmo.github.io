-- =====================================================================
-- COBRANÇAS PMO – Entrega do boleto (28/10/2026)
-- Por onde o boleto (ou a 1ª parcela do novo parcelamento) foi entregue ao
-- contribuinte. Separa a ENTREGA do campo meio_acordo, que passa a significar
-- "onde o acordo foi fechado" (o contato em que o contribuinte aceitou pagar).
-- =====================================================================
alter table public.lancamentos add column if not exists entrega_boleto text
  check (entrega_boleto in ('WhatsApp','Pessoalmente (Poupatempo)'));
