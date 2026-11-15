-- 009_trg_recurring.sql
-- Geração recorrente migrou para TS (runRecurringGeneration em
-- recurring_template/generator.ts). Componente vazio - DROP idempotente como
-- safety net.
DROP TRIGGER IF EXISTS trg_recurring_generation_run_ai ON core.recurring_generation_run;
DROP FUNCTION IF EXISTS core.fn_recurring_generation_run_ai();
