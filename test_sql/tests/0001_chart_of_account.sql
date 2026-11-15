-- 0001_chart_of_account.sql - Plano de contas global carregado
BEGIN;
SELECT plan(5);

-- Verificar que o plano global tem as contas principais
SELECT ok(EXISTS(SELECT 1 FROM finance.chart_of_account WHERE code = '121' AND condominium_id IS NULL),
   '121 Banco ordinário presente');
SELECT ok(EXISTS(SELECT 1 FROM finance.chart_of_account WHERE code = '721' AND condominium_id IS NULL),
   '721 Quotas Ordinárias presente');
SELECT ok(EXISTS(SELECT 1 FROM finance.chart_of_account WHERE code = '723' AND condominium_id IS NULL),
   '723 Contribuições FCR presente');
SELECT ok(EXISTS(SELECT 1 FROM finance.chart_of_account WHERE code = '2789' AND condominium_id IS NULL),
   '2789 Suspense presente');

-- Unicidade global: não pode haver 2 entradas com mesmo code em condominium_id NULL
SELECT is(
  (SELECT COUNT(*)::int FROM finance.chart_of_account WHERE code = '721' AND condominium_id IS NULL AND deleted_at IS NULL),
  1,
  'Apenas 1 account global com code=721'
);

SELECT * FROM finish();
ROLLBACK;
