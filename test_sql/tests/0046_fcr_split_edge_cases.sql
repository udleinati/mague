-- ═════════════════════════════════════════════════════════════════════════════
-- pgTAP: cobertura completa do split FCR em settlements.
--
-- 0044 cobre o caso base (settlement total de quota com FCR). Este ficheiro
-- cobre os edge cases:
--   (A) Reversal: settlement reversed deve desfazer o split (122 anula)
--   (B) Settlement parcial: 50% pago → ord/fcr proporcionais
--   (C) Múltiplos settlements sequenciais → soma final correcta
--   (D) Helper edge cases: NULL inputs, charge sem ledger
--   (E) Charge sem FCR (despesa) → tudo a 121, nada a 122
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(16);

-- ─── Setup base ─────────────────────────────────────────────────────────────
INSERT INTO core.condominium (id, name, designation_type, address)
VALUES ('_fcr_edge_condo', 'FCR Edge', 'condominium', 'Rua T');
INSERT INTO core.unit (id, condominium_id, designation, permillage)
VALUES ('_fcr_edge_unit', '_fcr_edge_condo', 'A', 100);
INSERT INTO core.budget (id, condominium_id, year, type, status, fcr_percentage)
VALUES ('_fcr_edge_budget', '_fcr_edge_condo', 2026, 'principal', 'approved', 10.00);
INSERT INTO finance.bank_account (id, condominium_id, bank_name, account_name, iban, kind,
  opening_balance, opening_balance_ordinary_cents, opening_balance_fcr_cents, opening_balance_date)
VALUES ('_fcr_edge_bank', '_fcr_edge_condo', 'Bk', 'P', 'PT50FE', 'bank', 0, 0, 0, '2026-01-01');

-- =============================================================================
-- (D) Helper edge cases - corre antes de criar ledger para testar fallbacks
-- =============================================================================

-- D1. charge_id NULL → tudo ord, fcr=0
SELECT is(
  (SELECT row(ord_part, fcr_part)::text FROM finance.fn_charge_fcr_split(NULL, 1000)),
  ROW(1000::int, 0::int)::text,
  '(D1) fn_charge_fcr_split(NULL, 1000) → (1000, 0) - fallback seguro'
);

-- D2. p_amount = 0 → (0, 0)
SELECT is(
  (SELECT row(ord_part, fcr_part)::text FROM finance.fn_charge_fcr_split('any', 0)),
  ROW(0::int, 0::int)::text,
  '(D2) fn_charge_fcr_split com amount=0 → (0, 0)'
);

-- D3. p_amount NULL → (0, 0)
SELECT is(
  (SELECT row(ord_part, fcr_part)::text FROM finance.fn_charge_fcr_split('any', NULL)),
  ROW(0::int, 0::int)::text,
  '(D3) fn_charge_fcr_split com amount NULL → (0, 0)'
);

-- D4. charge id que não existe (sem ledger) → all ord
SELECT is(
  (SELECT row(ord_part, fcr_part)::text FROM finance.fn_charge_fcr_split('inexistente', 5000)),
  ROW(5000::int, 0::int)::text,
  '(D4) fn_charge_fcr_split com charge inexistente → (5000, 0) - sem 723 no ledger'
);

-- =============================================================================
-- (E) Charge despesa (kind=payable, sem 723) - tudo deve ir a 121
-- =============================================================================

INSERT INTO finance.charge (
  id, condominium_id, unit_id, scope, kind, nature, charge_type, description,
  issue_date, due_date, competence_period, original_amount, expected_amount,
  open_amount, amount, status
) VALUES (
  '_fcr_edge_expense', '_fcr_edge_condo', NULL, 'condominium',
  'payable', 'debit', 'invoice',
  'Factura fornecedor', '2026-01-01', '2026-01-15', '2026-01-01',
  5000, 5000, 5000, 0, 'open'
);

SELECT is(
  (SELECT row(ord_part, fcr_part)::text
     FROM finance.fn_charge_fcr_split('_fcr_edge_expense', 5000)),
  ROW(5000::int, 0::int)::text,
  '(E1) Despesa (payable, sem 723) → (5000, 0) - sem split FCR'
);

-- =============================================================================
-- (A) (B) (C) Cenários com quota FCR - setup
-- =============================================================================

-- Quota: 110€ = 100 ord + 10 FCR
INSERT INTO finance.charge (
  id, condominium_id, unit_id, scope, kind, nature, charge_type, description,
  issue_date, due_date, competence_period, original_amount, expected_amount,
  open_amount, amount, source_type, source_id
) VALUES (
  '_fcr_edge_quota', '_fcr_edge_condo', '_fcr_edge_unit', 'unit',
  'receivable', 'debit', 'quota',
  'Quota Janeiro 110€ (10% FCR)', '2026-01-01', '2026-01-15', '2026-01-01',
  11000, 11000, 11000, 0, 'budget', '_fcr_edge_budget'
);

-- Confirma split inicial via fn_charge_ai
SELECT is(
  (SELECT amount FROM finance.ledger WHERE ref_id='_fcr_edge_quota' AND account_code='721' AND direction='credit')::int,
  10000,
  '(A0) Charge cria 721 = 10000'
);
SELECT is(
  (SELECT amount FROM finance.ledger WHERE ref_id='_fcr_edge_quota' AND account_code='723' AND direction='credit')::int,
  1000,
  '(A0b) Charge cria 723 = 1000'
);

-- =============================================================================
-- (B) Settlement PARCIAL: paga 5500 (metade) → ord 5000 + fcr 500
-- =============================================================================

INSERT INTO finance.bank_transaction (id, condominium_id, bank_account_id,
  transaction_date, amount, description, status)
VALUES ('_fcr_edge_btx1', '_fcr_edge_condo', '_fcr_edge_bank', '2026-01-20', 5500, 'P1', 'unreconciled');

INSERT INTO finance.settlement (id, settlement_type, condominium_id, unit_id,
  bank_transaction_id, debit_charge_id, debit_ref_type, debit_ref_id,
  amount, settlement_date, notes, status)
VALUES ('_fcr_edge_sett1', 'bank_reconciliation', '_fcr_edge_condo', '_fcr_edge_unit',
  '_fcr_edge_btx1', '_fcr_edge_quota', 'charge', '_fcr_edge_quota',
  5500, '2026-01-20', 'parcial 50%', 'active');

SELECT is(
  (SELECT amount FROM finance.ledger
    WHERE ref_id='_fcr_edge_sett1' AND account_code='121' AND direction='debit')::int,
  5000,
  '(B1) Parcial 50%: 121 = 5000 (proporcional)'
);
SELECT is(
  (SELECT amount FROM finance.ledger
    WHERE ref_id='_fcr_edge_sett1' AND account_code='122' AND direction='debit')::int,
  500,
  '(B2) Parcial 50%: 122 = 500 (proporcional)'
);

-- v_bank_balance reflete parcial
SELECT is(
  (SELECT ordinary_cents FROM finance.v_bank_balance WHERE condominium_id='_fcr_edge_condo'),
  5000,
  '(B3) v_bank_balance.ordinary_cents = 5000 após parcial'
);
SELECT is(
  (SELECT fcr_cents FROM finance.v_bank_balance WHERE condominium_id='_fcr_edge_condo'),
  500,
  '(B4) v_bank_balance.fcr_cents = 500 após parcial'
);

-- =============================================================================
-- (C) Settlement adicional 5500 → fica fully paid, soma certa
-- =============================================================================

INSERT INTO finance.bank_transaction (id, condominium_id, bank_account_id,
  transaction_date, amount, description, status)
VALUES ('_fcr_edge_btx2', '_fcr_edge_condo', '_fcr_edge_bank', '2026-02-20', 5500, 'P2', 'unreconciled');

INSERT INTO finance.settlement (id, settlement_type, condominium_id, unit_id,
  bank_transaction_id, debit_charge_id, debit_ref_type, debit_ref_id,
  amount, settlement_date, notes, status)
VALUES ('_fcr_edge_sett2', 'bank_reconciliation', '_fcr_edge_condo', '_fcr_edge_unit',
  '_fcr_edge_btx2', '_fcr_edge_quota', 'charge', '_fcr_edge_quota',
  5500, '2026-02-20', 'parcial 50% restante', 'active');

-- Total acumulado deve bater com a quota original (10000 ord + 1000 fcr)
SELECT is(
  (SELECT ordinary_cents FROM finance.v_bank_balance WHERE condominium_id='_fcr_edge_condo'),
  10000,
  '(C1) Após 2 parciais: ordinary_cents = 10000 (= 5000 + 5000)'
);
SELECT is(
  (SELECT fcr_cents FROM finance.v_bank_balance WHERE condominium_id='_fcr_edge_condo'),
  1000,
  '(C2) Após 2 parciais: fcr_cents = 1000 (= 500 + 500)'
);

-- =============================================================================
-- (A) Reversal de um settlement → undoes split correctly
-- =============================================================================

UPDATE finance.settlement SET status='reversed' WHERE id='_fcr_edge_sett1';

-- v_bank_balance pós-reversal: deve voltar ao estado pós-sett2 (5000+500)
SELECT is(
  (SELECT ordinary_cents FROM finance.v_bank_balance WHERE condominium_id='_fcr_edge_condo'),
  5000,
  '(A1) Pós reversal: ordinary_cents volta a 5000 (sett2 só)'
);
SELECT is(
  (SELECT fcr_cents FROM finance.v_bank_balance WHERE condominium_id='_fcr_edge_condo'),
  500,
  '(A2) Pós reversal: fcr_cents volta a 500 (sett2 só)'
);

-- A reversal emitiu ledger inverso com split - verifica
SELECT is(
  (SELECT count(*)::int FROM finance.ledger
    WHERE ref_id='_fcr_edge_sett1' AND entry_type='settlement_reversed'
      AND account_code IN ('121','122')),
  2,
  '(A3) Reversal emite 2 ledger entries (121 + 122) com split simétrico'
);

-- =============================================================================
-- Cleanup
-- =============================================================================
SET session_replication_role = replica;
DELETE FROM finance.ledger WHERE condominium_id='_fcr_edge_condo';
DELETE FROM finance.settlement WHERE condominium_id='_fcr_edge_condo';
DELETE FROM finance.bank_transaction WHERE condominium_id='_fcr_edge_condo';
DELETE FROM finance.charge WHERE condominium_id='_fcr_edge_condo';
DELETE FROM core.budget WHERE id='_fcr_edge_budget';
DELETE FROM finance.bank_account WHERE id='_fcr_edge_bank';
DELETE FROM core.unit WHERE id='_fcr_edge_unit';
DELETE FROM core.condominium WHERE id='_fcr_edge_condo';

SELECT * FROM finish();
ROLLBACK;
