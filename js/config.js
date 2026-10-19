// Configuração pública do sistema.
// A chave abaixo é a "publishable key" do Supabase: ela é pública por natureza.
// Quem protege os dados são as regras de acesso (RLS) do banco + o login.
window.APP_CONFIG = {
  SUPABASE_URL: 'https://SEU-PROJETO.supabase.co',
  SUPABASE_KEY: 'COLE-AQUI-A-PUBLISHABLE-KEY',
  INATIVIDADE_MIN: 30   // sai automaticamente após 30 min sem uso
};
