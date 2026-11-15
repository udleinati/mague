-- 015_settlements_quotas.sql - bank_transactions + settlements para conciliar
-- as quotas. Estratégia de cobertura (intent dos testes):
--   2020-2024 → 100% pagas; 2025 → 90%; 2026 → 60%.
-- Para cada quota paga: 1 bank_transaction (reconciled) + 1 settlement
-- (bank_reconciliation). O resto (settled_amount, status, ledger) é emitido por
-- fn_settlement_ai (component 004). 1:1 bt/settlement é simplificação do seed.

-- Limpa as bank_transactions do ficheiro 014 (recriadas aqui em massa).
DELETE FROM finance.bank_transaction
 WHERE condominium_id LIKE 'condo_max_%'
   AND id LIKE 'bt_max_%';

-- ── 2020-2024: TODAS as quotas pagas. ──────────────────────────────────
-- 1 bank_tx por quota + 1 settlement. Cada pagamento ocorre entre o dia
-- 5 e o dia 15 do mês (random-ish via mod). Status `reconciled` porque
-- a settlement já foi criada.
WITH bank_tx_inserts AS (
  INSERT INTO finance.bank_transaction (
    id, bank_account_id, condominium_id,
    transaction_date, value_date, amount, description, status
  )
  SELECT
    'bt_max_q_' || c.id,
    'ba_max_' || split_part(c.condominium_id, '_', 3),
    c.condominium_id,
    -- Pagamento entre dia 5 e 15 do mês de competência (mod 11 + 5).
    c.competence_period + ((extract(day from c.created_at)::int % 11 + 5) || ' days')::interval,
    c.competence_period + ((extract(day from c.created_at)::int % 11 + 5) || ' days')::interval,
    c.original_amount,
    'TRF SEPA - Quota ' || u.designation || ' ' ||
      to_char(c.competence_period, 'MM/YYYY'),
    'reconciled'
  FROM finance.charge c
  JOIN core.unit u ON u.id = c.unit_id
  WHERE c.condominium_id LIKE 'condo_max_%'
    AND c.kind = 'receivable'
    AND c.nature = 'debit'
    AND extract(year from c.competence_period) BETWEEN 2020 AND 2024
  RETURNING id, condominium_id, transaction_date, amount,
            -- recover charge_id from id (id = 'bt_max_q_' || charge.id)
            substring(id from 10) AS charge_id
)
INSERT INTO finance.settlement (
  id, condominium_id, unit_id, debit_charge_id, bank_transaction_id,
  amount, settlement_date, settlement_type, notes
)
SELECT
  's_max_q_' || bt.charge_id,
  bt.condominium_id,
  c.unit_id,
  bt.charge_id,
  bt.id,
  bt.amount,
  bt.transaction_date,
  'bank_reconciliation',
  'Pagamento auto - seed maximum'
FROM bank_tx_inserts bt
JOIN finance.charge c ON c.id = bt.charge_id;

-- ── 2025: 90% pagas (uma a cada 10 fica em aberto/overdue) ─────────────
WITH bank_tx_inserts AS (
  INSERT INTO finance.bank_transaction (
    id, bank_account_id, condominium_id,
    transaction_date, value_date, amount, description, status
  )
  SELECT
    'bt_max_q_' || c.id,
    'ba_max_' || split_part(c.condominium_id, '_', 3),
    c.condominium_id,
    c.competence_period + ((extract(day from c.created_at)::int % 11 + 5) || ' days')::interval,
    c.competence_period + ((extract(day from c.created_at)::int % 11 + 5) || ' days')::interval,
    c.original_amount,
    'TRF SEPA - Quota ' || u.designation || ' ' ||
      to_char(c.competence_period, 'MM/YYYY'),
    'reconciled'
  FROM finance.charge c
  JOIN core.unit u ON u.id = c.unit_id
  WHERE c.condominium_id LIKE 'condo_max_%'
    AND c.kind = 'receivable'
    AND c.nature = 'debit'
    AND extract(year from c.competence_period) = 2025
    -- Aproximadamente 90% (`abs(hashtext(id)) % 10 != 0`).
    AND abs(hashtext(c.id)) % 10 != 0
  RETURNING id, condominium_id, transaction_date, amount,
            substring(id from 10) AS charge_id
)
INSERT INTO finance.settlement (
  id, condominium_id, unit_id, debit_charge_id, bank_transaction_id,
  amount, settlement_date, settlement_type, notes
)
SELECT
  's_max_q_' || bt.charge_id,
  bt.condominium_id,
  c.unit_id,
  bt.charge_id,
  bt.id,
  bt.amount,
  bt.transaction_date,
  'bank_reconciliation',
  'Pagamento auto - seed maximum'
FROM bank_tx_inserts bt
JOIN finance.charge c ON c.id = bt.charge_id;

-- ── 2026: 60% pagas (4 em cada 10 ficam em aberto) ─────────────────────
WITH bank_tx_inserts AS (
  INSERT INTO finance.bank_transaction (
    id, bank_account_id, condominium_id,
    transaction_date, value_date, amount, description, status
  )
  SELECT
    'bt_max_q_' || c.id,
    'ba_max_' || split_part(c.condominium_id, '_', 3),
    c.condominium_id,
    c.competence_period + ((extract(day from c.created_at)::int % 11 + 5) || ' days')::interval,
    c.competence_period + ((extract(day from c.created_at)::int % 11 + 5) || ' days')::interval,
    c.original_amount,
    'TRF SEPA - Quota ' || u.designation || ' ' ||
      to_char(c.competence_period, 'MM/YYYY'),
    'reconciled'
  FROM finance.charge c
  JOIN core.unit u ON u.id = c.unit_id
  WHERE c.condominium_id LIKE 'condo_max_%'
    AND c.kind = 'receivable'
    AND c.nature = 'debit'
    AND extract(year from c.competence_period) = 2026
    AND abs(hashtext(c.id)) % 10 < 6   -- 60%
  RETURNING id, condominium_id, transaction_date, amount,
            substring(id from 10) AS charge_id
)
INSERT INTO finance.settlement (
  id, condominium_id, unit_id, debit_charge_id, bank_transaction_id,
  amount, settlement_date, settlement_type, notes
)
SELECT
  's_max_q_' || bt.charge_id,
  bt.condominium_id,
  c.unit_id,
  bt.charge_id,
  bt.id,
  bt.amount,
  bt.transaction_date,
  'bank_reconciliation',
  'Pagamento auto - seed maximum'
FROM bank_tx_inserts bt
JOIN finance.charge c ON c.id = bt.charge_id;
