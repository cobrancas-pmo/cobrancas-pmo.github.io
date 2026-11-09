-- =====================================================================
-- COBRANÇAS PMO – Gravação dos atendimentos de campanha (09/11/2026)
-- A função cwmkt (service_role) não conseguia gravar em atendimentos_wa: o gatilho
-- que liga o agente ao usuário do sistema chama privado.usuario_do_agente, e o
-- service_role não tem acesso ao esquema "privado" → erro 403 em todo insert.
-- Por isso nenhum atendimento foi gravado desde 06/11.
-- O gatilho passa a rodar com a permissão do dono (como as demais funções privadas).
-- =====================================================================
alter function privado.atendimento_wa_usuario() security definer;
alter function privado.atendimento_wa_usuario() set search_path to '';
