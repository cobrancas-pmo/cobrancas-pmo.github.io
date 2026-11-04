\set ON_ERROR_STOP 0
insert into auth.users (id, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-00000000000a','ana@x.com','{"nome":"Anderson Luiz"}'),
 ('00000000-0000-0000-0000-00000000000b','b@x.com','{"nome":"Juliana"}'),
 ('00000000-0000-0000-0000-00000000000e','s@x.com','{"nome":"Supervisora"}');
update perfis set ativo=true; update perfis set papel='supervisor' where nome='Supervisora';
-- lançamento em aberto já existente da Ana
set role authenticated; set request.jwt.claim.sub='00000000-0000-0000-0000-00000000000a';
insert into lancamentos (id_parcelamento, situacao, observacoes) values ('106326','AGUARDANDO RESPOSTA','obs antiga');
\echo '--- Ana tenta dividir (FALHA)'
select salvar_divisao('[{"id_parcelamento":"1","funcionario_id":"00000000-0000-0000-0000-00000000000a"}]');
reset role;
set role authenticated; set request.jwt.claim.sub='00000000-0000-0000-0000-00000000000e';
\echo '--- supervisora divide'
select salvar_divisao('[{"id_parcelamento":"106326","funcionario_id":"00000000-0000-0000-0000-00000000000a","valor":6682.2},{"id_parcelamento":"200","funcionario_id":"00000000-0000-0000-0000-00000000000b","valor":10}]');
reset role;
set role authenticated; set request.jwt.claim.sub='00000000-0000-0000-0000-00000000000a';
\echo '--- Ana tenta usar parcelamento da Juliana (FALHA)'
select registrar_campanha(array['SMS'], 'x.xlsx', '[{"id_parcelamento":"200"}]');
\echo '--- Ana registra campanha'
select registrar_campanha(array['SMS','E-mail'], 'Cobranca_Anderson.xlsx', '[{"id_parcelamento":"106326","telefone_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tem_email":true,"setor":"Imobiliário","origem":"20779","tipo_cobranca":"Antecipada"},{"id_parcelamento":"103666","setor":"Mobiliário","origem":"33798","tipo_cobranca":"Antecipada"}]');
select registrar_campanha(array['SMS'], 'y', '[{"id_parcelamento":"555"}]');
select id_parcelamento, sms, tipo_cobranca, campanha_id, data_contato, observacoes from lancamentos order by id;
select * from ja_em_campanha(array['106326','999']);
update lancamentos set situacao='BOLETO PAGO', valor_pago=100 where id_parcelamento='103666';
select relatorio_campanhas('2026-01-01','2026-12-31');
\echo '--- Ana insere item direto (FALHA)'
insert into campanha_itens (campanha_id,id_parcelamento) values (1,'9');
reset role;
set role authenticated; set request.jwt.claim.sub='00000000-0000-0000-0000-00000000000b';
\echo '--- Juliana vê 0 campanhas e relatório só dela'
select count(*) from campanhas; select count(*) from campanha_itens;
select relatorio_campanhas('2026-01-01','2026-12-31','00000000-0000-0000-0000-00000000000a')->'totais';
reset role;
set role anon; select count(*) from campanhas; select relatorio_campanhas('2026-01-01','2026-12-31'); reset role;
