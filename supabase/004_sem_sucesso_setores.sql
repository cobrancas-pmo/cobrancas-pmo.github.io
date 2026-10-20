-- =====================================================================
-- COBRANÇAS PMO – Ajustes de nomenclatura (20/10/2026)
-- * Situações "REVOGADO – …" passam a "SEM SUCESSO – …": a revogação do
--   acordo é decidida pela Recuperação de Ativos, não pela cobrança.
--   (Os lançamentos acompanham automaticamente: FK com ON UPDATE CASCADE.)
-- * Setor "Contribuinte" é o mesmo que "CRC": lançamentos migrados e setor desativado.
-- * Setor "Outros" passa a "UC" (unidade consumidora – débitos de água da antiga SAE).
-- =====================================================================

update public.situacoes
   set codigo = 'SEM SUCESSO – ' || substring(codigo from char_length('REVOGADO – ') + 1)
 where codigo like 'REVOGADO – %';

update public.lancamentos set setor = 'CRC' where setor = 'Contribuinte';
update public.setores set ativo = false where nome = 'Contribuinte';

update public.setores set nome = 'UC', ordem = 4 where nome = 'Outros';
