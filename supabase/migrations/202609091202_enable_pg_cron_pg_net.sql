-- =============================================================================
-- 202609091202_enable_pg_cron_pg_net.sql
--
-- Ativa pg_cron, pg_net e supabase_vault — já presentes em
-- shared_preload_libraries (confirmado via `show shared_preload_libraries`),
-- só faltando o CREATE EXTENSION que cria os schemas/objetos (cron.*, net.*,
-- vault.*) neste banco. Idempotente — seguro reaplicar.
--
-- Nenhum segredo é gravado aqui. O valor do CRON_SECRET é armazenado à parte,
-- manualmente, via `select vault.create_secret(...)` rodado direto no SQL
-- Editor — nunca commitado neste repositório (mesma disciplina já usada para
-- as env vars do EasyPanel).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE;
