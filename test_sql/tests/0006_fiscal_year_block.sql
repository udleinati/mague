-- 0006_fiscal_year_block.sql - Bloqueio de ano fiscal encerrado (Q7)
BEGIN;
SELECT plan(2);

-- Setup
INSERT INTO core.condominium (id, name) VALUES ('cd_fy01', 'Test Condo FY01');
INSERT INTO core.unit (id, condominium_id, designation, permillage) VALUES ('u_fy01', 'cd_fy01', 'A', 100);

-- Ano 2099 encerrado
INSERT INTO finance.fiscal_year (id, condominium_id, year, start_date, end_date, status)
VALUES ('fy_fy01', 'cd_fy01', 2099, '2099-01-01', '2099-12-31', 'closed');

-- Tentar inserir charge com competência em 2099 → falha
SELECT throws_ok($$
  INSERT INTO finance.charge (id, condominium_id, unit_id, kind, nature, charge_type, status,
    scope, issue_date, due_date, competence_period,
    original_amount, expected_amount, open_amount, description)
  VALUES ('ch_fy01', 'cd_fy01', 'u_fy01', 'receivable', 'debit', 'quota', 'open',
    'unit', '2099-05-01', '2099-05-08', '2099-05-01',
    10000, 10000, 10000, 'Quota retro');
$$,
  NULL,
  NULL,
  'INSERT em ano fiscal encerrado falha');

-- Charge em ano 2098 (open) funciona
INSERT INTO finance.fiscal_year (id, condominium_id, year, start_date, end_date, status)
VALUES ('fy_fy01_2098', 'cd_fy01', 2098, '2098-01-01', '2098-12-31', 'open');

INSERT INTO core.budget (id, condominium_id, year, status, type, fcr_percentage)
VALUES ('bfy_fy01', 'cd_fy01', 2098, 'approved', 'principal', 10.00);

INSERT INTO finance.charge (id, condominium_id, unit_id, kind, nature, charge_type, status,
  scope, issue_date, due_date, competence_period,
  original_amount, expected_amount, open_amount, description, source_type, source_id)
VALUES ('ch_fy01_ok', 'cd_fy01', 'u_fy01', 'receivable', 'debit', 'quota', 'open',
  'unit', '2098-05-01', '2098-05-08', '2098-05-01',
  11000, 11000, 11000, 'Quota Maio/2098', 'budget', 'bfy_fy01');

SELECT ok(EXISTS(SELECT 1 FROM finance.charge WHERE id = 'ch_fy01_ok'),
  'INSERT em ano open funciona');

SELECT * FROM finish();
ROLLBACK;
