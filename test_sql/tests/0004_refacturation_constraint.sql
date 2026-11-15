-- 0004_refacturation_constraint.sql - Validação da constraint de refacturação (DE8)
BEGIN;
SELECT plan(4);

-- Setup
INSERT INTO core.condominium (id, name) VALUES ('cd_r01', 'Test Condo R01');
INSERT INTO core.unit (id, condominium_id, designation, permillage) VALUES ('u_r01', 'cd_r01', 'A', 100);

INSERT INTO finance.chart_of_account (id, code, condominium_id, name, type, parent_code)
VALUES ('acc_ene_r01', '62401', 'cd_r01', 'Energia', 'expense', '624'),
       ('acc_oth_r01', '62261', 'cd_r01', 'Outros', 'expense', '6226');

-- Despesa base 300€ energia
INSERT INTO finance.charge (id, condominium_id, kind, nature, charge_type, status,
  scope, issue_date, due_date, competence_period,
  original_amount, expected_amount, open_amount, description, account_id)
VALUES ('ch_exp_r01', 'cd_r01', 'payable', 'debit', 'supplier_service', 'open',
  'condominium', '2099-04-01', '2099-04-15', '2099-04-01',
  30000, 30000, 30000, 'Energia Abril', 'acc_ene_r01');

-- 1. Refacturação válida (mesma account_id, kind=payable source, condominium igual) → sucesso
INSERT INTO finance.charge (id, condominium_id, unit_id, kind, nature, charge_type, status,
  scope, issue_date, due_date, competence_period,
  original_amount, expected_amount, open_amount, description, account_id,
  source_type, source_id)
VALUES ('ch_ref_r01', 'cd_r01', 'u_r01', 'receivable', 'debit', 'refacturation', 'open',
  'unit', '2099-04-01', '2099-04-15', '2099-04-01',
  10000, 10000, 10000, 'Refact. energia garagem', 'acc_ene_r01',
  'refacturation', 'ch_exp_r01');

SELECT ok(EXISTS(SELECT 1 FROM finance.charge WHERE id = 'ch_ref_r01'),
  'Refacturação válida aceita');

-- 2. Refacturação sem source_type → falha
SELECT throws_ok($$
  INSERT INTO finance.charge (id, condominium_id, unit_id, kind, nature, charge_type, status,
    scope, issue_date, due_date, competence_period,
    original_amount, expected_amount, open_amount, description, account_id)
  VALUES ('ch_ref_bad1', 'cd_r01', 'u_r01', 'receivable', 'debit', 'refacturation', 'open',
    'unit', '2099-04-01', '2099-04-15', '2099-04-01',
    1000, 1000, 1000, 'Inválida', 'acc_ene_r01');
$$,
  NULL,
  NULL,
  'Refacturação sem source_type falha');

-- 3. Refacturação com account_id diferente → falha
SELECT throws_ok($$
  INSERT INTO finance.charge (id, condominium_id, unit_id, kind, nature, charge_type, status,
    scope, issue_date, due_date, competence_period,
    original_amount, expected_amount, open_amount, description, account_id,
    source_type, source_id)
  VALUES ('ch_ref_bad2', 'cd_r01', 'u_r01', 'receivable', 'debit', 'refacturation', 'open',
    'unit', '2099-04-01', '2099-04-15', '2099-04-01',
    1000, 1000, 1000, 'Inválida', 'acc_oth_r01',
    'refacturation', 'ch_exp_r01');
$$,
  NULL,
  NULL,
  'Refacturação com account_id diferente falha');

-- 4. Refacturação apontando para charge inexistente → falha
SELECT throws_ok($$
  INSERT INTO finance.charge (id, condominium_id, unit_id, kind, nature, charge_type, status,
    scope, issue_date, due_date, competence_period,
    original_amount, expected_amount, open_amount, description, account_id,
    source_type, source_id)
  VALUES ('ch_ref_bad3', 'cd_r01', 'u_r01', 'receivable', 'debit', 'refacturation', 'open',
    'unit', '2099-04-01', '2099-04-15', '2099-04-01',
    1000, 1000, 1000, 'Inválida', 'acc_ene_r01',
    'refacturation', 'ch_not_exists');
$$,
  NULL,
  NULL,
  'Refacturação com source_id inexistente falha');

SELECT * FROM finish();
ROLLBACK;
