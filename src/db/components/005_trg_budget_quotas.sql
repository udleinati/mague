-- 005_trg_budget_quotas.sql
-- Geração de quotas migrou para TS (ADR 0001:
-- runQuotaGeneration). Componente vazio - DROP idempotente como safety net.
DROP FUNCTION IF EXISTS public.fn_budget_generate_quotas() CASCADE;
DROP FUNCTION IF EXISTS fn_budget_generate_quotas() CASCADE;
