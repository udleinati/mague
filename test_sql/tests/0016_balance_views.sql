-- 0016_balance_views.sql
-- Views `v_unit_balance` e `v_bank_balance`.
--
-- v_unit_balance agrega por fração (a partir de finance.charge):
--   - open_debt_cents    (nature=debit,  status ∈ open/partial/overdue)
--   - open_credit_cents  (nature=credit, idem)
--   - overdue_debt_cents (status=overdue, debit)
--   - net_cents          (debt − credit)
--
-- v_bank_balance agrega por condomínio (a partir de finance.ledger):
--   - ordinary_cents (account 121, Σ debit − credit)
--   - fcr_cents      (account 122)
--   - total_cents
BEGIN;
SELECT plan(11);

-- ═══ Setup ══════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_bv', 'Balance Views Test');
INSERT INTO core.unit (id, condominium_id, designation, permillage, is_active) VALUES
  ('u_bv_a', 'cd_bv', 'A', 500, true),
  ('u_bv_b', 'cd_bv', 'B', 500, true);

-- ═══ v_unit_balance ═══════════════════════════════════════════════════════
-- Unit A: apenas dívidas (sem credit para evitar auto-compensação do trigger
-- fn_charge_ai, que nos interessa estar fora de escopo desta view test).
-- NOTA: a view v_unit_balance usa `due_date <= reconciled_through_date`
-- - exige cutoff definido no condomínio. Sem cutoff `overdue_debt_cents = 0`
-- (não acusamos atraso sem o admin afirmar). Setamos cutoff = 2099-06-30 para
-- que ch_bv_a2 (due 2020-12-31) fique vencida e ch_bv_a1 (due 2099-12-31) não.
UPDATE core.condominium SET reconciled_through_date = '2099-06-30' WHERE id = 'cd_bv';
INSERT INTO finance.charge
  (id, condominium_id, unit_id, scope, kind, nature, charge_type, status,
   issue_date, due_date, competence_period, original_amount, open_amount, amount, description)
VALUES
  ('ch_bv_a1', 'cd_bv', 'u_bv_a', 'unit', 'receivable', 'debit', 'quota', 'open',
   '2099-01-15', '2099-12-31', '2099-01-01', 10000, 10000, 0, 'Quota Jan A (due futuro)'),
  ('ch_bv_a2', 'cd_bv', 'u_bv_a', 'unit', 'receivable', 'debit', 'quota', 'overdue',
   '2020-12-01', '2020-12-31', '2020-12-01', 3000, 3000, 0, 'Quota Dez 2020 A (vencida)');

-- Unit B: só crédito (nenhuma dívida para compensar). O trigger fn_charge_ai
-- não encontra débitos → credit fica em aberto.
INSERT INTO finance.charge
  (id, condominium_id, unit_id, scope, kind, nature, charge_type, status,
   issue_date, competence_period, original_amount, open_amount, amount, description)
VALUES
  ('ch_bv_b1', 'cd_bv', 'u_bv_b', 'unit', 'receivable', 'credit', 'credit_adjustment', 'open',
   '2099-01-20', '2099-01-01', 2000, 2000, 0, 'Reembolso B');

-- Charge de condomínio (scope=condominium) - view deve IGNORAR.
INSERT INTO finance.charge
  (id, condominium_id, unit_id, scope, kind, nature, charge_type, status,
   issue_date, competence_period, original_amount, open_amount, amount, description)
VALUES
  ('ch_bv_c1', 'cd_bv', NULL, 'condominium', 'receivable', 'credit', 'openingBalance', 'open',
   '2099-01-01', '2099-01-01', 100000, 100000, 0, 'Opening balance');

-- Unit A: só débitos → debt = 100 + 30, credit = 0
SELECT is(
  (SELECT open_debt_cents FROM finance.v_unit_balance
    WHERE unit_id = 'u_bv_a' AND condominium_id = 'cd_bv'),
  13000,
  'Unit A: open_debt_cents = 13000 (100 + 30, só débitos)'
);

SELECT is(
  (SELECT open_credit_cents FROM finance.v_unit_balance
    WHERE unit_id = 'u_bv_a' AND condominium_id = 'cd_bv'),
  0,
  'Unit A: open_credit_cents = 0 (sem créditos)'
);

SELECT is(
  (SELECT overdue_debt_cents FROM finance.v_unit_balance
    WHERE unit_id = 'u_bv_a' AND condominium_id = 'cd_bv'),
  3000,
  'Unit A: overdue_debt_cents = 3000'
);

SELECT is(
  (SELECT net_cents FROM finance.v_unit_balance
    WHERE unit_id = 'u_bv_a' AND condominium_id = 'cd_bv'),
  13000,
  'Unit A: net_cents = 13000 (debt − credit)'
);

-- Unit B: só crédito - debt=0, credit=20, net=-20
SELECT is(
  (SELECT open_debt_cents FROM finance.v_unit_balance
    WHERE unit_id = 'u_bv_b' AND condominium_id = 'cd_bv'),
  0,
  'Unit B: open_debt_cents = 0 (só crédito)'
);
SELECT is(
  (SELECT open_credit_cents FROM finance.v_unit_balance
    WHERE unit_id = 'u_bv_b' AND condominium_id = 'cd_bv'),
  2000,
  'Unit B: open_credit_cents = 2000'
);

-- Scope=condominium deve ser EXCLUÍDO da view.
-- Contamos linhas do view para este condo: devem ser 2 (A e B), nunca 3.
SELECT is(
  (SELECT COUNT(*)::int FROM finance.v_unit_balance WHERE condominium_id = 'cd_bv'),
  2,
  'View só considera scope=unit (ignora charge openingBalance)'
);

-- ═══ v_bank_balance ═══════════════════════════════════════════════════════
-- Posta ledger directo: 500€ ordinário + 200€ FCR (como se fosse openingBalance).
INSERT INTO finance.ledger
  (id, condominium_id, entry_date, entry_type, account_code, direction, amount, description)
VALUES
  ('le_bv_1', 'cd_bv', '2099-01-01', 'openingBalance', '121', 'debit', 50000, 'Ord.'),
  ('le_bv_2', 'cd_bv', '2099-01-01', 'openingBalance', '59',   'credit', 50000, 'Retained'),
  ('le_bv_3', 'cd_bv', '2099-01-01', 'openingBalance', '122', 'debit', 20000, 'FCR'),
  ('le_bv_4', 'cd_bv', '2099-01-01', 'openingBalance', '581',   'credit', 20000, 'FCR equity');

-- Despesa de 100€ ordinária: Dr 6226 100, Cr 121 100.
INSERT INTO finance.ledger
  (id, condominium_id, entry_date, entry_type, account_code, direction, amount, description)
VALUES
  ('le_bv_5', 'cd_bv', '2099-02-01', 'charge_settled', '6226', 'debit', 10000, 'Despesa'),
  ('le_bv_6', 'cd_bv', '2099-02-01', 'charge_settled', '121', 'credit', 10000, 'Saída banco');

-- Ordinary: 500 - 100 = 400
SELECT is(
  (SELECT ordinary_cents FROM finance.v_bank_balance WHERE condominium_id = 'cd_bv'),
  40000,
  'v_bank_balance: ordinary_cents = 40000 (500 − 100 gasto)'
);

-- FCR: 200 (intacto)
SELECT is(
  (SELECT fcr_cents FROM finance.v_bank_balance WHERE condominium_id = 'cd_bv'),
  20000,
  'v_bank_balance: fcr_cents = 20000'
);

-- Total: 400 + 200 = 600
SELECT is(
  (SELECT total_cents FROM finance.v_bank_balance WHERE condominium_id = 'cd_bv'),
  60000,
  'v_bank_balance: total_cents = 60000 (ord + fcr)'
);

-- Ledger entries noutros accounts (581, 59, 6226) NÃO entram no balance.
-- A view só olha para 121 e 122 - verificação implícita nos 3 asserts acima.
SELECT is(
  (SELECT COUNT(*)::int FROM finance.v_bank_balance WHERE condominium_id = 'cd_bv'),
  1,
  'v_bank_balance devolve uma só linha por condomínio'
);

SELECT * FROM finish();
ROLLBACK;
