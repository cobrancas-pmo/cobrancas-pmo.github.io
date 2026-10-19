# Cobranças PMO

Sistema web para o controle diário de cobranças e para os relatórios mensal, trimestral, semestral e anual.

- **Sem dados pessoais:** não guarda nome nem telefone do contribuinte. O lançamento é identificado pelo **Id do parcelamento**.
- **Telas:** só arquivos estáticos (HTML, CSS e JS), publicados no GitHub Pages.
- **Banco e login:** Supabase (PostgreSQL), com regras de acesso por linha (RLS):
  - cada funcionário vê e edita apenas os próprios lançamentos;
  - a supervisão consulta tudo, sem editar;
  - o administrador libera acessos e mantém as listas padronizadas;
  - toda inclusão, alteração ou exclusão fica registrada na auditoria;
  - sem login, nada é acessível.
- A chave em `js/config.js` é a *publishable key* do Supabase, que é pública por natureza. A proteção dos dados vem do login e das regras de acesso do banco.

## Estrutura

| Caminho | Conteúdo |
|---|---|
| `index.html`, `css/`, `js/` | o site |
| `vendor/` | bibliotecas (supabase-js 2.45.4, Chart.js 4.4.1), servidas localmente |
| `supabase/schema.sql` | tabelas, regras de acesso, auditoria e função de relatório |
| `supabase/test_rls.sql` | testes das regras de acesso (usados com `test_stub.sql` num PostgreSQL local) |

## Implantação

1. Rode `supabase/schema.sql` no projeto Supabase (SQL Editor).
2. Em **Authentication → URL Configuration**, coloque o endereço do GitHub Pages em *Site URL* e em *Redirect URLs*.
3. Preencha `js/config.js` com a URL do projeto e a *publishable key*.
4. Crie sua conta pelo site ("Solicitar acesso") e torne-se administrador no SQL Editor:
   `update public.perfis set papel = 'admin', ativo = true where email = 'seu@email';`
5. Os demais funcionários solicitam acesso pelo site, e o administrador libera em **Administração**.
