-- 0002_quota_double_entry.sql - Quota ordinária gera 3 linhas no ledger (Dr + 2×Cr com split FCR)
BEGIN;
SELECT plan(6);

-- Setup
INSERT INTO core.condominium (id, name) VALUES ('cd_q01', 'Test Condo Q01');
INSERT INTO core.unit (id, condominium_id, designation, permillage) VALUES ('u_q01', 'cd_q01', 'A', 100);
-- role é 'super' | NULL (ADR 0002) - admin per-condo vem
-- de core.manager.user_id, não desta coluna.
INSERT INTO core."user" (id, name, email, role) VALUES ('uq01', 'Admin', 'admin_q01@test.pt', NULL);
INSERT INTO core.budget (id, condominium_id, year, status, type, fcr_percentage, approved_at, approved_by)
  VALUES ('bq01', 'cd_q01', 2099, 'approved', 'principal', 10.00, now(), 'uq01');

-- Cria charge quota 110€ (100 ord + 10 FCR)
INSERT INTO finance.charge (id, condominium_id, unit_id, kind, nature, charge_type, status,
  scope, issue_date, due_date, competence_period,
  original_amount, open_amount, expected_amount, description, source_type, source_id)
VALUES ('ch_q01', 'cd_q01', 'u_q01', 'receivable', 'debit', 'quota', 'open',
  'unit', '2099-01-01', '2099-01-08', '2099-01-01',
  11000, 11000, 11000, 'Quota Jan/2099', 'budget', 'bq01');

-- Verificações
SELECT is((SELECT COUNT(*)::int FROM finance.ledger WHERE ref_id = 'ch_q01'), 3,
  'Quota gera 3 linhas (Dr A Receber + Cr 721 + Cr 723)');

SELECT is((SELECT amount FROM finance.ledger
           WHERE ref_id = 'ch_q01' AND account_code = '2111' AND direction = 'debit'),
  11000,
  'Dr 2111 = 11000 (valor total)');

SELECT is((SELECT amount FROM finance.ledger
           WHERE ref_id = 'ch_q01' AND account_code = '721' AND direction = 'credit'),
  10000,
  'Cr 721 = 10000 (parte ordinária)');

SELECT is((SELECT amount FROM finance.ledger
           WHERE ref_id = 'ch_q01' AND account_code = '723' AND direction = 'credit'),
  1000,
  'Cr 723 = 1000 (parte FCR)');

-- Balanço (Dr total = Cr total)
SELECT is(
  (SELECT SUM(CASE WHEN direction='debit' THEN amount ELSE 0 END) -
          SUM(CASE WHEN direction='credit' THEN amount ELSE 0 END)
     FROM finance.ledger WHERE ref_id = 'ch_q01'),
  0::bigint,
  'Ledger da quota: soma Dr = soma Cr'
);

SELECT is(
  (SELECT status FROM finance.charge WHERE id = 'ch_q01'),
  'open',
  'Charge está open'
);

SELECT * FROM finish();
ROLLBACK;
