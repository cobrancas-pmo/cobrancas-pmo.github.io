\pset pager off
\set ON_ERROR_STOP 0
-- Pré-requisito: test_stub.sql + schema.sql + 002_cancelamentos.sql + usuários de test_rls.sql
\echo '=== ANA lança 3 casos (2 para cancelamento)'
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
insert into public.lancamentos (data_contato,id_parcelamento,setor,situacao,observacoes) values
 ('2026-10-19','900001','Imobiliário','ENVIAR PARA CANCELAMENTO','sem renegociação'),
 ('2026-10-19','900002','CRC','ENVIAR PARA CANCELAMENTO',null),
 ('2026-10-19','900003','CRC','AGUARDANDO RESPOSTA',null);
select id_parcelamento, situacao, cancelamento_status from public.lancamentos where id_parcelamento like '9000%' order by 1;
\echo '--- Ana tenta marcar como Cancelado manualmente (deve continuar Aguardando envio)'
update public.lancamentos set cancelamento_status='Cancelado' where id_parcelamento='900001';
select cancelamento_status from public.lancamentos where id_parcelamento='900001';
\echo '--- Ana tenta inserir já como Enviado (situação não gera cancelamento: deve ficar vazio)'
insert into public.lancamentos (id_parcelamento,situacao,cancelamento_status) values ('900004','AGUARDANDO RESPOSTA','Enviado');
select cancelamento_status from public.lancamentos where id_parcelamento='900004';
\echo '--- Ana tenta gerar lote (deve FALHAR)'
select public.gerar_lote_cancelamento();
\echo '--- Ana muda 900002 de volta para AGUARDANDO RESPOSTA antes do envio (sai da fila)'
update public.lancamentos set situacao='AGUARDANDO RESPOSTA' where id_parcelamento='900002';
select cancelamento_status from public.lancamentos where id_parcelamento='900002';
update public.lancamentos set situacao='ENVIAR PARA CANCELAMENTO' where id_parcelamento='900002';
reset role;

\echo '=== BRUNO lança 1 caso para cancelamento'
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
insert into public.lancamentos (data_contato,id_parcelamento,setor,situacao) values ('2026-10-20','900010','Mobiliário','ENVIAR PARA CANCELAMENTO');
reset role;

\echo '=== SUPERVISORA retira 900010 da fila e gera o lote'
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
select public.atualizar_cancelamento((select id from public.lancamentos where id_parcelamento='900010'), 'Retirado', 'acordo de última hora');
select id_parcelamento, cancelamento_status from public.lancamentos where cancelamento_status is not null order by 1;
select public.gerar_lote_cancelamento(null, 'Lote de teste') as lote_id;
select numero, quantidade, observacao from public.lotes_cancelamento;
select id_parcelamento, cancelamento_status, cancelamento_lote is not null as tem_lote from public.lancamentos where cancelamento_status is not null order by 1;
\echo '--- gerar de novo sem casos (deve FALHAR: não há casos)'
select public.gerar_lote_cancelamento();
\echo '--- marca 900001 Cancelado e 900002 Devolvido'
select public.atualizar_cancelamento((select id from public.lancamentos where id_parcelamento='900001'), 'Cancelado', null);
select public.atualizar_cancelamento((select id from public.lancamentos where id_parcelamento='900002'), 'Devolvido', 'parcelamento já quitado');
\echo '--- tentar voltar caso enviado para Aguardando envio (deve FALHAR)'
select public.atualizar_cancelamento((select id from public.lancamentos where id_parcelamento='900001'), 'Aguardando envio', null);
select (public.relatorio('2026-10-01','2026-10-31')->'totais') - array['sms','dias','whatsapp','ligacoes','agendamentos','parcelas','funcionarios','pago_sem_valor','outros','valor','boletos','pagos'] as totais_canc;
reset role;

\echo '=== ANA muda situação de caso já enviado (status deve continuar Cancelado)'
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
update public.lancamentos set situacao='AGUARDANDO RESPOSTA' where id_parcelamento='900001';
select id_parcelamento, cancelamento_status from public.lancamentos where id_parcelamento like '9000%' order by 1;
select count(*) as ana_ve_lotes from public.lotes_cancelamento;
reset role;

\echo '=== ANON não vê lotes nem chama funções'
set role anon;
select count(*) from public.lotes_cancelamento;
select public.gerar_lote_cancelamento();
reset role;
