-- 0068_charge_cancel_ledger.sql
--
-- Anulação no ledger quando uma charge passa a 'cancelled' (fn_charge_au).
--
-- Cobre o que o trigger promete:
--   • débito cancelado: o lançamento inverso deixa as contas da charge a zero
--   • crédito cancelado: nada a anular (fn_charge_ai não lançou nada ao nascer);
--     antes lançava Dr 7888 / Cr 2782 sem origem e desequilibrava as contas

BEGIN;
SELECT plan(3);

INSERT INTO core.condominium (id, name) VALUES ('cd_ccl', 'Charge Cancel Ledger Test');
INSERT INTO core.unit (id, condominium_id, designation, permillage)
VALUES ('u_ccl', 'cd_ccl', 'A', 1000);

-- ═══ Test 1: débito cancelado anula o lançamento da criação ══════════════════
INSERT INTO finance.charge (id, condominium_id, unit_id, kind, nature, charge_type, status,
  scope, issue_date, competence_period,
  original_amount, expected_amount, open_amount, description)
VALUES ('ch_ccl_deb', 'cd_ccl', 'u_ccl', 'receivable', 'debit', 'opening_balance_debit', 'open',
  'unit', '2099-03-01', '2099-03-01',
  12000, 12000, 12000, 'Dívida lançada por engano');

UPDATE finance.charge SET status = 'cancelled' WHERE id = 'ch_ccl_deb';

SELECT is(
  (SELECT count(*)::int FROM finance.ledger
    WHERE ref_type = 'charge' AND ref_id = 'ch_ccl_deb' AND entry_type = 'charge_cancelled'),
  2,
  'débito cancelado emite as duas linhas de charge_cancelled'
);

SELECT is(
  (SELECT COALESCE(SUM(CASE direction WHEN 'debit' THEN amount ELSE -amount END), 0)::int
     FROM finance.ledger WHERE ref_type = 'charge' AND ref_id = 'ch_ccl_deb'
     GROUP BY account_code HAVING SUM(CASE direction WHEN 'debit' THEN amount ELSE -amount END) <> 0
     LIMIT 1),
  NULL,
  'débito cancelado: cada conta da charge fica a zero'
);

-- ═══ Test 2: crédito cancelado não lança nada ═══════════════════════════════
INSERT INTO finance.charge (id, condominium_id, unit_id, kind, nature, charge_type, status,
  scope, issue_date, competence_period,
  original_amount, expected_amount, open_amount, description)
VALUES ('ch_ccl_cred', 'cd_ccl', 'u_ccl', 'receivable', 'credit', 'credit_adjustment', 'open',
  'unit', '2099-03-01', '2099-03-01',
  3000, 3000, 3000, 'Crédito lançado por engano');

UPDATE finance.charge SET status = 'cancelled' WHERE id = 'ch_ccl_cred';

SELECT is(
  (SELECT count(*)::int FROM finance.ledger WHERE ref_type = 'charge' AND ref_id = 'ch_ccl_cred'),
  0,
  'crédito cancelado não deixa lançamentos sem origem no ledger'
);

SELECT * FROM finish();
ROLLBACK;
