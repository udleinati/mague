-- ═════════════════════════════════════════════════════════════════════════════
-- pgTAP: settlement de quota com FCR splitta o lado banco em 121 + 122.
--
-- `fn_settlement_ai` (component 004): quando uma quota com FCR% > 0 é
-- reconciliada via bank_transaction, o ledger emite:
--   - Dr 121 ord_part   (parte ordinária)
--   - Dr 122 fcr_part   (parte FCR)
--   - Cr conta-da-charge (total)
--
-- Resultado: `v_bank_balance.fcr_cents` reflete cumulativamente as
-- contribuições FCR recebidas via quotas, alinhado com `723` (proveito FCR).
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(7);

-- ─── Setup ─────────────────────────────────────────────────────────────────
INSERT INTO core.condominium (id, name, designation_type, address)
VALUES ('_fcrtest_condo', 'FCR Split Test', 'condominium', 'Rua Teste, 1');

INSERT INTO core.unit (id, condominium_id, designation, permillage)
VALUES ('_fcrtest_unit', '_fcrtest_condo', 'A', 100);

INSERT INTO core.budget (id, condominium_id, year, type, status, fcr_percentage)
VALUES ('_fcrtest_budget', '_fcrtest_condo', 2026, 'principal', 'approved', 10.00);
-- 10% FCR - quotas geradas a partir deste budget têm split 90/10

INSERT INTO finance.bank_account (
  id, condominium_id, bank_name, account_name, iban, kind,
  opening_balance, opening_balance_ordinary_cents, opening_balance_fcr_cents,
  opening_balance_date
) VALUES (
  '_fcrtest_bank', '_fcrtest_condo', 'BancoTeste', 'Principal',
  'PT50TEST', 'bank', 0, 0, 0, '2026-01-01'
);

-- ─── Cria quota: 110€ total = 100€ ord + 10€ FCR ──────────────────────────
-- O trigger fn_charge_ai vai automaticamente emitir 721=100, 723=10.
INSERT INTO finance.charge (
  id, condominium_id, unit_id, scope, kind, nature, charge_type,
  description, issue_date, due_date, competence_period,
  original_amount, expected_amount, open_amount, amount,
  source_type, source_id
) VALUES (
  '_fcrtest_quota', '_fcrtest_condo', '_fcrtest_unit', 'unit',
  'receivable', 'debit', 'quota',
  'Quota Janeiro 2026 (110€ = 100 ord + 10 FCR)',
  '2026-01-01', '2026-01-15', '2026-01-01',
  11000, 11000, 11000, 0,  -- 110€ em cêntimos
  'budget', '_fcrtest_budget'
);

-- ─── Confirma split inicial do ledger (721 + 723) ────────────────────────
SELECT is(
  (SELECT amount FROM finance.ledger
    WHERE ref_id='_fcrtest_quota' AND account_code='721' AND direction='credit')::int,
  10000,
  '(1) Charge cria ledger Cr 721 = 10000 (ordinário)'
);
SELECT is(
  (SELECT amount FROM finance.ledger
    WHERE ref_id='_fcrtest_quota' AND account_code='723' AND direction='credit')::int,
  1000,
  '(2) Charge cria ledger Cr 723 = 1000 (FCR)'
);

-- ─── Bank tx + settlement bank_reconciliation (paga toda a quota) ─────────
INSERT INTO finance.bank_transaction (
  id, condominium_id, bank_account_id, transaction_date, amount,
  description, status
) VALUES (
  '_fcrtest_btx', '_fcrtest_condo', '_fcrtest_bank', '2026-01-20', 11000,
  'Pagamento quota Janeiro', 'unreconciled'
);

INSERT INTO finance.settlement (
  id, settlement_type, condominium_id, unit_id,
  bank_transaction_id, debit_charge_id,
  debit_ref_type, debit_ref_id,
  amount, settlement_date, notes, status
) VALUES (
  '_fcrtest_sett', 'bank_reconciliation', '_fcrtest_condo', '_fcrtest_unit',
  '_fcrtest_btx', '_fcrtest_quota',
  'charge', '_fcrtest_quota',
  11000, '2026-01-20', 'Reconciliação quota Jan', 'active'
);

-- ─── REGRESSION (3): banco 121 recebe 100€ (ord_part) ──────────────────────
SELECT is(
  (SELECT amount FROM finance.ledger
    WHERE ref_id='_fcrtest_sett' AND account_code='121' AND direction='debit')::int,
  10000,
  '(3) Settlement emite Dr 121 = 10000 (parte ordinária do split)'
);

-- ─── REGRESSION (4): banco 122 recebe 10€ (fcr_part) ───────────────────────
-- Sem o split FCR no settlement, este registo não existe (NULL).
SELECT is(
  (SELECT amount FROM finance.ledger
    WHERE ref_id='_fcrtest_sett' AND account_code='122' AND direction='debit')::int,
  1000,
  '(4) Settlement emite Dr 122 = 1000 (parte FCR do split)'
);

-- ─── REGRESSION (5): contrapartida charge total (devedor reduz 110) ───────
SELECT is(
  (SELECT amount FROM finance.ledger
    WHERE ref_id='_fcrtest_sett' AND account_code='2111' AND direction='credit')::int,
  11000,
  '(5) Settlement emite Cr 2111 = 11000 (total da quota recolhido do devedor)'
);

-- ─── REGRESSION (6): v_bank_balance reflete o split ──────────────────────
SELECT is(
  (SELECT ordinary_cents FROM finance.v_bank_balance WHERE condominium_id='_fcrtest_condo'),
  10000,
  '(6) v_bank_balance.ordinary_cents = 10000 (parte ordinária do pagamento)'
);
SELECT is(
  (SELECT fcr_cents FROM finance.v_bank_balance WHERE condominium_id='_fcrtest_condo'),
  1000,
  '(7) v_bank_balance.fcr_cents = 1000 (parte FCR - alinhada com 723)'
);

-- ─── Cleanup ──────────────────────────────────────────────────────────────
SET session_replication_role = replica;
DELETE FROM finance.ledger WHERE condominium_id='_fcrtest_condo';
DELETE FROM finance.settlement WHERE id='_fcrtest_sett';
DELETE FROM finance.bank_transaction WHERE id='_fcrtest_btx';
DELETE FROM finance.charge WHERE id='_fcrtest_quota';
DELETE FROM core.budget WHERE id='_fcrtest_budget';
DELETE FROM finance.bank_account WHERE id='_fcrtest_bank';
DELETE FROM core.unit WHERE id='_fcrtest_unit';
DELETE FROM core.condominium WHERE id='_fcrtest_condo';

SELECT * FROM finish();
ROLLBACK;
