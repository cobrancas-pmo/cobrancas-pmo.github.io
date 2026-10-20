-- =====================================================================
-- COBRANÇAS PMO – Exclusão de situações sem uso (20/10/2026)
-- * O administrador pode excluir situações que nunca foram usadas.
--   Situações já usadas em lançamentos continuam protegidas pela chave
--   estrangeira (o histórico não se perde): para essas, desativa-se.
-- * uso_situacoes(): quantos lançamentos usam cada situação (respeita o RLS).
-- =====================================================================

grant delete on public.situacoes to authenticated;   -- o RLS abaixo limita ao administrador
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'situacoes' and policyname = 'situacoes_admin_del') then
    create policy situacoes_admin_del on public.situacoes for delete to authenticated
      using ((select privado.meu_papel()) = 'admin');
  end if;
end $$;

create or replace function public.uso_situacoes()
returns table (codigo text, qtde bigint) language sql stable security invoker set search_path = '' as $$
  select l.situacao, count(*) from public.lancamentos l where l.situacao is not null group by l.situacao
$$;
revoke all on function public.uso_situacoes() from public, anon;
grant execute on function public.uso_situacoes() to authenticated;
