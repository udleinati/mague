-- 016_settlements_payable.sql - bank_transactions de saída + settlements
-- para conciliar despesas pagas a fornecedores.
--
-- Estratégia:
--   2020-2024 → 95% pagas
--   2025      → 80% pagas
--   2026      → 50% pagas
--
-- 1 bank_tx (saída) por despesa paga + 1 settlement.

-- ── 2020-2024: 95% pagas ───────────────────────────────────────────────
WITH bank_tx_inserts AS (
  INSERT INTO finance.bank_transaction (
    id, bank_account_id, condominium_id,
    transaction_date, value_date, amount, description, status
  )
  SELECT
    'bt_max_p_' || c.id,
    'ba_max_' || split_part(c.condominium_id, '_', 3),
    c.condominium_id,
    -- Saída entre dia 25 e 28 (depois do due_date que é dia 25).
    c.due_date + ((extract(day from c.created_at)::int % 4) || ' days')::interval,
    c.due_date + ((extract(day from c.created_at)::int % 4) || ' days')::interval,
    -c.original_amount,                                -- saída = amount negativo
    'PAG SEPA - ' || COALESCE(s.name, 'Fornecedor') || ' ' ||
      to_char(c.competence_period, 'MM/YYYY'),
    'reconciled'
  FROM finance.charge c
  LEFT JOIN core.supplier s ON s.id = c.supplier_id
  WHERE c.condominium_id LIKE 'condo_max_%'
    AND c.kind = 'payable'
    AND c.nature = 'debit'
    AND extract(year from c.competence_period) BETWEEN 2020 AND 2024
    AND abs(hashtext(c.id)) % 20 != 0    -- 95%
  RETURNING id, condominium_id, transaction_date, amount,
            substring(id from 10) AS charge_id
)
INSERT INTO finance.settlement (
  id, condominium_id, debit_charge_id, bank_transaction_id,
  amount, settlement_date, settlement_type, notes
)
SELECT
  's_max_p_' || bt.charge_id,
  bt.condominium_id,
  bt.charge_id,
  bt.id,
  abs(bt.amount),                                     -- settlement amount é positivo
  bt.transaction_date,
  'bank_reconciliation',
  'Pagamento fornecedor - seed maximum'
FROM bank_tx_inserts bt;

-- ── 2025: 80% pagas ────────────────────────────────────────────────────
WITH bank_tx_inserts AS (
  INSERT INTO finance.bank_transaction (
    id, bank_account_id, condominium_id,
    transaction_date, value_date, amount, description, status
  )
  SELECT
    'bt_max_p_' || c.id,
    'ba_max_' || split_part(c.condominium_id, '_', 3),
    c.condominium_id,
    c.due_date + ((extract(day from c.created_at)::int % 4) || ' days')::interval,
    c.due_date + ((extract(day from c.created_at)::int % 4) || ' days')::interval,
    -c.original_amount,
    'PAG SEPA - ' || COALESCE(s.name, 'Fornecedor') || ' ' ||
      to_char(c.competence_period, 'MM/YYYY'),
    'reconciled'
  FROM finance.charge c
  LEFT JOIN core.supplier s ON s.id = c.supplier_id
  WHERE c.condominium_id LIKE 'condo_max_%'
    AND c.kind = 'payable'
    AND c.nature = 'debit'
    AND extract(year from c.competence_period) = 2025
    AND abs(hashtext(c.id)) % 5 != 0      -- 80%
  RETURNING id, condominium_id, transaction_date, amount,
            substring(id from 10) AS charge_id
)
INSERT INTO finance.settlement (
  id, condominium_id, debit_charge_id, bank_transaction_id,
  amount, settlement_date, settlement_type, notes
)
SELECT
  's_max_p_' || bt.charge_id,
  bt.condominium_id,
  bt.charge_id,
  bt.id,
  abs(bt.amount),
  bt.transaction_date,
  'bank_reconciliation',
  'Pagamento fornecedor - seed maximum'
FROM bank_tx_inserts bt;

-- ── 2026: 50% pagas ────────────────────────────────────────────────────
WITH bank_tx_inserts AS (
  INSERT INTO finance.bank_transaction (
    id, bank_account_id, condominium_id,
    transaction_date, value_date, amount, description, status
  )
  SELECT
    'bt_max_p_' || c.id,
    'ba_max_' || split_part(c.condominium_id, '_', 3),
    c.condominium_id,
    c.due_date + ((extract(day from c.created_at)::int % 4) || ' days')::interval,
    c.due_date + ((extract(day from c.created_at)::int % 4) || ' days')::interval,
    -c.original_amount,
    'PAG SEPA - ' || COALESCE(s.name, 'Fornecedor') || ' ' ||
      to_char(c.competence_period, 'MM/YYYY'),
    'reconciled'
  FROM finance.charge c
  LEFT JOIN core.supplier s ON s.id = c.supplier_id
  WHERE c.condominium_id LIKE 'condo_max_%'
    AND c.kind = 'payable'
    AND c.nature = 'debit'
    AND extract(year from c.competence_period) = 2026
    AND abs(hashtext(c.id)) % 2 = 0       -- 50%
  RETURNING id, condominium_id, transaction_date, amount,
            substring(id from 10) AS charge_id
)
INSERT INTO finance.settlement (
  id, condominium_id, debit_charge_id, bank_transaction_id,
  amount, settlement_date, settlement_type, notes
)
SELECT
  's_max_p_' || bt.charge_id,
  bt.condominium_id,
  bt.charge_id,
  bt.id,
  abs(bt.amount),
  bt.transaction_date,
  'bank_reconciliation',
  'Pagamento fornecedor - seed maximum'
FROM bank_tx_inserts bt;
