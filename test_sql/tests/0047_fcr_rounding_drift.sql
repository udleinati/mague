-- ═════════════════════════════════════════════════════════════════════════════
-- pgTAP: drift cumulativo do split FCR com percentagens irregulares.
--
-- O `fn_charge_fcr_split` usa `ROUND(amount * fcr / (fcr + ord))` para
-- calcular `fcr_part`, e `ord_part = amount - fcr_part`. Isso garante zero
-- perda no settlement individual, mas com percentagens irregulares (33%,
-- 7%, 12.5%) cada quota tem rounding até ±1 cêntimo. Em 12 meses, o drift
-- pode acumular?
--
-- Invariantes a verificar:
--   (A) Em cada settlement, ord_part + fcr_part == amount (zero perda)
--   (B) Acumulado: Σ(121) + Σ(122) == Σ(amount) - sem cêntimos a perder
--   (C) Ratio cumulativo aproxima-se de fcr% real (max 1 cêntimo de desvio
--       por quota - para 12 quotas isso é ±12 cêntimos absolutos)
--
-- Cenários:
--   - 33% FCR, 12 quotas de 11900€ cada (split: 8947 ord + 2953 fcr nominal,
--     mas com rounding pode variar)
--   - 7% FCR, 6 quotas de 13700€ cada
--   - 12.5% FCR, 4 quotas de 4500€ cada
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(9);

-- ─── Setup ─────────────────────────────────────────────────────────────────
INSERT INTO core.condominium (id, name, designation_type, address)
VALUES ('_drift_condo', 'Drift Test', 'condominium', 'Rua T');
INSERT INTO core.unit (id, condominium_id, designation, permillage)
VALUES ('_drift_unit', '_drift_condo', 'A', 100);
INSERT INTO finance.bank_account (id, condominium_id, bank_name, account_name, iban, kind,
  opening_balance, opening_balance_ordinary_cents, opening_balance_fcr_cents, opening_balance_date)
VALUES ('_drift_bank', '_drift_condo', 'Bk', 'P', 'PT50DR', 'bank', 0, 0, 0, '2026-01-01');

-- =============================================================================
-- Cenário 1: 33% FCR, 12 quotas de 11900€ cada
-- Total: 142800€ → ord teórico: ~107368€, fcr teórico: ~35432€
-- =============================================================================

INSERT INTO core.budget (id, condominium_id, year, type, status, fcr_percentage)
VALUES ('_drift_b1', '_drift_condo', 2026, 'principal', 'approved', 33.00);

DO $$
DECLARE i integer; v_charge_id text; v_btx_id text; v_set_id text;
BEGIN
  FOR i IN 1..12 LOOP
    v_charge_id := '_drift_q1_' || i;
    INSERT INTO finance.charge (
      id, condominium_id, unit_id, scope, kind, nature, charge_type, description,
      issue_date, due_date, competence_period, original_amount, expected_amount,
      open_amount, amount, source_type, source_id
    ) VALUES (
      v_charge_id, '_drift_condo', '_drift_unit', 'unit',
      'receivable', 'debit', 'quota', 'Q33 ' || i,
      ('2026-' || LPAD(i::text, 2, '0') || '-01')::date,
      ('2026-' || LPAD(i::text, 2, '0') || '-15')::date,
      ('2026-' || LPAD(i::text, 2, '0') || '-01')::date,
      11900, 11900, 11900, 0, 'budget', '_drift_b1'
    );

    -- Bank tx + settlement integral
    v_btx_id := '_drift_btx1_' || i;
    INSERT INTO finance.bank_transaction (id, condominium_id, bank_account_id,
      transaction_date, amount, description, status)
    VALUES (v_btx_id, '_drift_condo', '_drift_bank',
      ('2026-' || LPAD(i::text, 2, '0') || '-20')::date, 11900, 'P', 'unreconciled');

    v_set_id := '_drift_set1_' || i;
    INSERT INTO finance.settlement (id, settlement_type, condominium_id, unit_id,
      bank_transaction_id, debit_charge_id, debit_ref_type, debit_ref_id,
      amount, settlement_date, notes, status)
    VALUES (v_set_id, 'bank_reconciliation', '_drift_condo', '_drift_unit',
      v_btx_id, v_charge_id, 'charge', v_charge_id,
      11900, ('2026-' || LPAD(i::text, 2, '0') || '-20')::date, 'rec', 'active');
  END LOOP;
END $$;

-- (A) Para cada settlement, ord + fcr == amount (sem perda)
SELECT is(
  (SELECT count(*)::int FROM finance.settlement s
    WHERE s.condominium_id='_drift_condo' AND s.settlement_type='bank_reconciliation'
      AND (
        (SELECT COALESCE(SUM(amount),0)::int FROM finance.ledger
          WHERE ref_id=s.id AND account_code='121' AND direction='debit')
        +
        (SELECT COALESCE(SUM(amount),0)::int FROM finance.ledger
          WHERE ref_id=s.id AND account_code='122' AND direction='debit')
      ) <> s.amount),
  0,
  '(A1) 33% FCR - em todos os 12 settlements: ord_part + fcr_part = amount (zero perda)'
);

-- (B) Acumulado total bate
SELECT is(
  (SELECT total_cents FROM finance.v_bank_balance WHERE condominium_id='_drift_condo'),
  12 * 11900, -- 142800
  '(B1) 33% FCR - total_cents = 12 × 11900 = 142800 (sem cêntimos perdidos)'
);

-- (C) Ratio cumulativo: fcr_cents/total dentro de ±1% do esperado
-- Para 33% aditivo: fcr% efetivo = 33/(100+33) = 24.81%
SELECT cmp_ok(
  (SELECT fcr_cents::numeric / total_cents FROM finance.v_bank_balance
    WHERE condominium_id='_drift_condo'),
  '<=',
  0.255::numeric,
  '(C1a) 33% FCR - ratio fcr/total ≤ 25.5% (esperado ~24.81%)'
);
SELECT cmp_ok(
  (SELECT fcr_cents::numeric / total_cents FROM finance.v_bank_balance
    WHERE condominium_id='_drift_condo'),
  '>=',
  0.245::numeric,
  '(C1b) 33% FCR - ratio fcr/total ≥ 24.5%'
);

-- =============================================================================
-- Cenário 2: 7% FCR, 6 quotas de 13700€ cada
-- =============================================================================

INSERT INTO core.budget (id, condominium_id, year, type, status, fcr_percentage)
VALUES ('_drift_b2', '_drift_condo', 2027, 'principal', 'approved', 7.00);

DO $$
DECLARE i integer; v_charge_id text; v_btx_id text; v_set_id text;
BEGIN
  FOR i IN 1..6 LOOP
    v_charge_id := '_drift_q2_' || i;
    INSERT INTO finance.charge (
      id, condominium_id, unit_id, scope, kind, nature, charge_type, description,
      issue_date, due_date, competence_period, original_amount, expected_amount,
      open_amount, amount, source_type, source_id
    ) VALUES (
      v_charge_id, '_drift_condo', '_drift_unit', 'unit',
      'receivable', 'debit', 'quota', 'Q7 ' || i,
      ('2027-' || LPAD(i::text, 2, '0') || '-01')::date,
      ('2027-' || LPAD(i::text, 2, '0') || '-15')::date,
      ('2027-' || LPAD(i::text, 2, '0') || '-01')::date,
      13700, 13700, 13700, 0, 'budget', '_drift_b2'
    );

    v_btx_id := '_drift_btx2_' || i;
    INSERT INTO finance.bank_transaction (id, condominium_id, bank_account_id,
      transaction_date, amount, description, status)
    VALUES (v_btx_id, '_drift_condo', '_drift_bank',
      ('2027-' || LPAD(i::text, 2, '0') || '-20')::date, 13700, 'P', 'unreconciled');

    v_set_id := '_drift_set2_' || i;
    INSERT INTO finance.settlement (id, settlement_type, condominium_id, unit_id,
      bank_transaction_id, debit_charge_id, debit_ref_type, debit_ref_id,
      amount, settlement_date, notes, status)
    VALUES (v_set_id, 'bank_reconciliation', '_drift_condo', '_drift_unit',
      v_btx_id, v_charge_id, 'charge', v_charge_id,
      13700, ('2027-' || LPAD(i::text, 2, '0') || '-20')::date, 'rec', 'active');
  END LOOP;
END $$;

-- Acumulado pós cenário 2: 142800 + 6×13700 = 225000
SELECT is(
  (SELECT total_cents FROM finance.v_bank_balance WHERE condominium_id='_drift_condo'),
  225000,
  '(B2) Acumulado 33%+7%: total = 12×11900 + 6×13700 = 225000'
);

-- =============================================================================
-- Cenário 3: 12.5% FCR, 4 quotas de 4500€ cada (rounding fraccional clássico)
-- =============================================================================

INSERT INTO core.budget (id, condominium_id, year, type, status, fcr_percentage)
VALUES ('_drift_b3', '_drift_condo', 2028, 'principal', 'approved', 12.50);

DO $$
DECLARE i integer; v_charge_id text; v_btx_id text; v_set_id text;
BEGIN
  FOR i IN 1..4 LOOP
    v_charge_id := '_drift_q3_' || i;
    INSERT INTO finance.charge (
      id, condominium_id, unit_id, scope, kind, nature, charge_type, description,
      issue_date, due_date, competence_period, original_amount, expected_amount,
      open_amount, amount, source_type, source_id
    ) VALUES (
      v_charge_id, '_drift_condo', '_drift_unit', 'unit',
      'receivable', 'debit', 'quota', 'Q12.5 ' || i,
      ('2028-' || LPAD(i::text, 2, '0') || '-01')::date,
      ('2028-' || LPAD(i::text, 2, '0') || '-15')::date,
      ('2028-' || LPAD(i::text, 2, '0') || '-01')::date,
      4500, 4500, 4500, 0, 'budget', '_drift_b3'
    );
    v_btx_id := '_drift_btx3_' || i;
    INSERT INTO finance.bank_transaction (id, condominium_id, bank_account_id,
      transaction_date, amount, description, status)
    VALUES (v_btx_id, '_drift_condo', '_drift_bank',
      ('2028-' || LPAD(i::text, 2, '0') || '-20')::date, 4500, 'P', 'unreconciled');
    v_set_id := '_drift_set3_' || i;
    INSERT INTO finance.settlement (id, settlement_type, condominium_id, unit_id,
      bank_transaction_id, debit_charge_id, debit_ref_type, debit_ref_id,
      amount, settlement_date, notes, status)
    VALUES (v_set_id, 'bank_reconciliation', '_drift_condo', '_drift_unit',
      v_btx_id, v_charge_id, 'charge', v_charge_id,
      4500, ('2028-' || LPAD(i::text, 2, '0') || '-20')::date, 'rec', 'active');
  END LOOP;
END $$;

-- Acumulado total final: 225000 + 4×4500 = 243000
SELECT is(
  (SELECT total_cents FROM finance.v_bank_balance WHERE condominium_id='_drift_condo'),
  243000,
  '(B3) Acumulado final (33%+7%+12.5%): total = 243000'
);

-- (B-final) Σ(121) + Σ(122) = Σ(settlement.amount). Zero cêntimos perdidos
-- mesmo com 22 settlements e 3 % diferentes.
SELECT is(
  (SELECT COALESCE(SUM(s.amount),0)::int FROM finance.settlement s
    WHERE s.condominium_id='_drift_condo' AND s.status='active'),
  243000,
  '(B-final) Σ(settlement.amount) = 243000'
);

SELECT is(
  (SELECT
    (SELECT COALESCE(SUM(amount),0)::int FROM finance.ledger
      WHERE condominium_id='_drift_condo' AND account_code='121' AND direction='debit')
    +
    (SELECT COALESCE(SUM(amount),0)::int FROM finance.ledger
      WHERE condominium_id='_drift_condo' AND account_code='122' AND direction='debit')),
  243000,
  '(B-final) Σ(121 debit) + Σ(122 debit) = 243000 (sem perda cumulativa)'
);

-- (C-final) Proveito FCR 723 vs FCR bank 122 - devem bater (modulo rounding)
-- Cada quota emite Cr 723 (=fcr part). Settlement reconcilia. Em estado
-- estável: fcr_bank ≈ fcr_revenue (modulo arredondamentos das duas funções
-- distintas: fn_charge_ai usa formula diferente do fn_charge_fcr_split).
SELECT cmp_ok(
  ABS(
    (SELECT fcr_cents FROM finance.v_bank_balance WHERE condominium_id='_drift_condo')
    -
    (SELECT COALESCE(SUM(amount),0)::int FROM finance.ledger
      WHERE condominium_id='_drift_condo' AND account_code='723' AND direction='credit')
  ),
  '<=',
  22, -- 22 settlements × 1 cêntimo = ±22 cêntimos máx absoluto
  '(C-final) |bank_fcr - revenue_723| ≤ 22 cêntimos (1 cêntimo por settlement)'
);

-- ─── Cleanup ──────────────────────────────────────────────────────────────
SET session_replication_role = replica;
DELETE FROM finance.ledger WHERE condominium_id='_drift_condo';
DELETE FROM finance.settlement WHERE condominium_id='_drift_condo';
DELETE FROM finance.bank_transaction WHERE condominium_id='_drift_condo';
DELETE FROM finance.charge WHERE condominium_id='_drift_condo';
DELETE FROM core.budget WHERE condominium_id='_drift_condo';
DELETE FROM finance.bank_account WHERE id='_drift_bank';
DELETE FROM core.unit WHERE id='_drift_unit';
DELETE FROM core.condominium WHERE id='_drift_condo';

SELECT * FROM finish();
ROLLBACK;
