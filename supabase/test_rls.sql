\set ON_ERROR_STOP 0
\pset pager off
-- usuários de teste
insert into auth.users (id, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-00000000000a','ana@x.com','{"nome":"Ana"}'),
 ('00000000-0000-0000-0000-00000000000b','bruno@x.com','{"nome":"Bruno"}'),
 ('00000000-0000-0000-0000-00000000000c','carla@x.com','{"nome":"Carla"}'),
 ('00000000-0000-0000-0000-00000000000d','dono@x.com','{"nome":"Admin"}'),
 ('00000000-0000-0000-0000-00000000000e','super@x.com','{"nome":"Supervisora"}');
update public.perfis set ativo = true where nome in ('Ana','Bruno','Admin','Supervisora');
update public.perfis set papel='admin' where nome='Admin';
update public.perfis set papel='supervisor' where nome='Supervisora';
select nome, papel, ativo from public.perfis order by nome;

\echo '=== ANON: deve ver 0 linhas / erro de permissão'
set role anon;
select count(*) from public.lancamentos;
select count(*) from public.perfis;
select public.relatorio('2026-01-01','2026-12-31');
reset role;

\echo '=== ANA insere 3 lançamentos'
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
insert into public.lancamentos (data_contato,id_parcelamento,setor,whatsapp,boleto_emitido,parcelas,situacao,valor_pago)
 values ('2026-10-19','103800','Imobiliário','Enviado','2026-10-19',2,'BOLETO PAGO',388.15),
        ('2026-10-19','106364','CRC','Enviado',null,null,'REVOGADO – SEM RESPOSTA',null),
        ('2026-10-20','100493','Mobiliário','Sem WhatsApp',null,null,null,null);
\echo '--- Ana tenta inserir em nome do Bruno (deve FALHAR)'
insert into public.lancamentos (funcionario_id,id_parcelamento) values ('00000000-0000-0000-0000-00000000000b','999');
\echo '--- Ana tenta virar admin (deve FALHAR)'
update public.perfis set papel='admin' where id='00000000-0000-0000-0000-00000000000a';
\echo '--- Ana tenta ativar a Carla (deve afetar 0 linhas)'
update public.perfis set ativo=true where nome='Carla';
\echo '--- Ana: id inválido com nome (deve FALHAR pelo check)'
insert into public.lancamentos (id_parcelamento) values ('JOAO DA SILVA 1499999');
reset role;

\echo '=== BRUNO insere 1 e tenta ver/alterar os da Ana'
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
insert into public.lancamentos (data_contato,id_parcelamento,setor,situacao,valor_pago,parcelas,boleto_emitido)
 values ('2026-10-19','555','Imobiliário','BOLETO PAGO',100,1,'2026-10-19');
select count(*) as bruno_ve from public.lancamentos;            -- esperado 1
update public.lancamentos set valor_pago = 1 where id_parcelamento='103800';  -- esperado UPDATE 0
delete from public.lancamentos where id_parcelamento='103800';                -- esperado DELETE 0
select count(*) as perfis_que_bruno_ve from public.perfis;     -- esperado 1
select count(*) as auditoria_bruno from public.auditoria;      -- esperado 0
select public.relatorio('2026-10-01','2026-10-31')->'totais' as rel_bruno;
reset role;

\echo '=== CARLA (inativa) não vê nem grava'
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select count(*) as carla_ve from public.lancamentos;
insert into public.lancamentos (id_parcelamento) values ('777');
select count(*) as carla_situacoes from public.situacoes;
reset role;

\echo '=== SUPERVISORA vê tudo, não edita'
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000e';
select count(*) as super_ve from public.lancamentos;            -- esperado 4
update public.lancamentos set valor_pago = 1;                    -- esperado UPDATE 0
select public.relatorio('2026-10-01','2026-10-31')->'totais' as rel_equipe;
select jsonb_pretty(public.relatorio('2026-10-01','2026-10-31')->'por_funcionario');
select count(*) as auditoria_super from public.auditoria;      -- esperado 0
reset role;

\echo '=== ADMIN ativa Carla, lê auditoria'
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000d';
update public.perfis set ativo=true where nome='Carla';
select count(*) as auditoria_admin from public.auditoria;
select jsonb_pretty(public.relatorio('2026-10-01','2026-10-31', '00000000-0000-0000-0000-00000000000a'));
reset role;
