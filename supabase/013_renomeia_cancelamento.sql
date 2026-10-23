-- =====================================================================
-- COBRANÇAS PMO – Renomeia situação (23/10/2026)
-- "ENVIAR PARA CANCELAMENTO" passa a se chamar "CANCELAMENTO".
-- Os lançamentos acompanham automaticamente (FK com ON UPDATE CASCADE);
-- a fila e os lotes de cancelamento não mudam.
-- =====================================================================
update public.situacoes
   set codigo = 'CANCELAMENTO',
       descricao = coalesce(descricao, 'Sem possibilidade de renegociação: o caso entra na fila do relatório semanal à Recuperação de Ativos.')
 where codigo = 'ENVIAR PARA CANCELAMENTO';
