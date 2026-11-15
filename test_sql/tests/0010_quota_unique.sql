-- 0010_quota_unique.sql
--
-- UNIQUE INDEX `uq_charge_quota_unit_period_source`: impede 2 quotas
-- não-cancelled para a mesma fração no mesmo período de competência +
-- mesmo source_id (budget).
--
-- Cancellation via state machine (`status='cancelled'`) liberta o slot -
-- a charge não tem `deleted_at`.

BEGIN;
SELECT plan(5);

INSERT INTO core.condominium (id, name) VALUES ('cd_uq', 'Test Condo Unique');
INSERT INTO core.unit (id, condominium_id, designation, permillage, is_active)
  VALUES ('u_uq', 'cd_uq', 'A', 100, true);
INSERT INTO core.budget (id, condominium_id, year, status, type, fcr_percentage)
  VALUES ('bud_uq', 'cd_uq', 2099, 'approved', 'principal', 0);

-- Primeira quota Março 2099 - OK
INSERT INTO finance.charge (id, condominium_id, unit_id, kind, nature, charge_type, status,
    scope, issue_date, due_date, competence_period,
    original_amount, expected_amount, open_amount, description, source_type, source_id)
VALUES ('ch_uq1', 'cd_uq', 'u_uq', 'receivable', 'debit', 'quota', 'open',
    'unit', '2099-03-01', '2099-03-08', '2099-03-01', 10000, 10000, 10000, 'Q Março', 'budget', 'bud_uq');

SELECT is((SELECT COUNT(*)::int FROM finance.charge WHERE id='ch_uq1'), 1,
  'Primeira quota inserida');

-- Segunda quota Março 2099 mesma unit - deve falhar (índice único ativo)
SELECT throws_ok(
  $$INSERT INTO finance.charge (id, condominium_id, unit_id, kind, nature, charge_type, status,
      scope, issue_date, due_date, competence_period,
      original_amount, expected_amount, open_amount, description, source_type, source_id)
    VALUES ('ch_uq_dup', 'cd_uq', 'u_uq', 'receivable', 'debit', 'quota', 'open',
      'unit', '2099-03-01', '2099-03-08', '2099-03-01', 10000, 10000, 10000, 'Q Março dup', 'budget', 'bud_uq')$$,
  '23505',
  NULL,
  'Quota duplicada (mesma unit+período+budget) é rejeitada');

-- Cancellation via state machine permite re-emitir nova quota ao mesmo
-- período.
UPDATE finance.charge SET status = 'cancelled' WHERE id='ch_uq1';

INSERT INTO finance.charge (id, condominium_id, unit_id, kind, nature, charge_type, status,
    scope, issue_date, due_date, competence_period,
    original_amount, expected_amount, open_amount, description, source_type, source_id)
VALUES ('ch_uq2', 'cd_uq', 'u_uq', 'receivable', 'debit', 'quota', 'open',
    'unit', '2099-03-01', '2099-03-08', '2099-03-01', 10000, 10000, 10000, 'Q Março 2', 'budget', 'bud_uq');

SELECT is((SELECT COUNT(*)::int FROM finance.charge
           WHERE unit_id='u_uq' AND competence_period='2099-03-01'
             AND charge_type='quota' AND status <> 'cancelled'),
  1, 'Após cancellation, nova quota pode ser inserida (1 ativa)');

-- extraordinary_quota no mesmo período não é bloqueada (índice apenas para 'quota')
INSERT INTO finance.charge (id, condominium_id, unit_id, kind, nature, charge_type, status,
    scope, issue_date, due_date, competence_period,
    original_amount, expected_amount, open_amount, description)
VALUES ('ch_uq_ext', 'cd_uq', 'u_uq', 'receivable', 'debit', 'extraordinary_quota', 'open',
    'unit', '2099-03-01', '2099-03-08', '2099-03-01', 5000, 5000, 5000, 'Ext Março');

SELECT is((SELECT COUNT(*)::int FROM finance.charge
           WHERE id='ch_uq_ext'), 1,
  'extraordinary_quota no mesmo período é permitida');

-- Budget-origem diferente (source_id) pode coexistir no mesmo unit+período.
-- Suplementar exige parent_budget_id (budget_type_parent_check) - usamos bud_uq.
INSERT INTO core.budget (id, condominium_id, year, status, type, fcr_percentage, parent_budget_id)
  VALUES ('bud_uq_supl', 'cd_uq', 2099, 'approved', 'suplementar', 0, 'bud_uq');

INSERT INTO finance.charge (id, condominium_id, unit_id, kind, nature, charge_type, status,
    scope, issue_date, due_date, competence_period,
    original_amount, expected_amount, open_amount, description, source_type, source_id)
VALUES ('ch_uq_supl', 'cd_uq', 'u_uq', 'receivable', 'debit', 'quota', 'open',
    'unit', '2099-03-01', '2099-03-08', '2099-03-01', 5000, 5000, 5000, 'Q Março supl', 'budget', 'bud_uq_supl');

SELECT is((SELECT COUNT(*)::int FROM finance.charge
           WHERE unit_id='u_uq' AND competence_period='2099-03-01'
             AND charge_type='quota' AND status <> 'cancelled'),
  2, 'Quotas de budgets diferentes (principal + suplementar) coexistem');

SELECT * FROM finish();
ROLLBACK;
