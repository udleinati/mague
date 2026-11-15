-- 006_views_balance.sql
-- Vistas agregadas de saldos a partir de finance.charge (balance_unit =
-- receivables por fração; balance_supplier = payables por fornecedor).
-- Convenções current_*/future_*/total_*/net_balance: ver COMMENT ON VIEW.

-- Limpa nomes antigos (renomeação de finance.balance / finance.supplier_balance)
DROP VIEW IF EXISTS finance.balance;
DROP VIEW IF EXISTS finance.supplier_balance;

-- ═══════════════════════════════════════════════════════════════════════════════
-- finance.balance_unit - receivables por fração
-- ═══════════════════════════════════════════════════════════════════════════════

DROP VIEW IF EXISTS finance.balance_unit;
CREATE VIEW finance.balance_unit AS
SELECT
  c.condominium_id,
  c.unit_id,

  -- CURRENT
  SUM(CASE WHEN nature='debit' AND competence_period <= CURRENT_DATE
           THEN open_amount ELSE 0 END)              AS current_open_debit,
  SUM(CASE WHEN nature='credit'
           THEN open_amount ELSE 0 END)              AS current_open_credit,
  SUM(CASE WHEN nature='credit' THEN open_amount ELSE 0 END)
    - SUM(CASE WHEN nature='debit' AND competence_period <= CURRENT_DATE
                THEN open_amount ELSE 0 END)        AS current_net_balance,

  -- FUTURE
  SUM(CASE WHEN nature='debit' AND competence_period > CURRENT_DATE
           THEN open_amount ELSE 0 END)              AS future_open_debit,

  -- TOTAL
  SUM(CASE WHEN nature='debit'  THEN open_amount ELSE 0 END) AS total_open_debit,
  SUM(CASE WHEN nature='credit' THEN open_amount ELSE 0 END) AS total_open_credit,
  SUM(CASE WHEN nature='credit' THEN open_amount ELSE 0 END)
    - SUM(CASE WHEN nature='debit' THEN open_amount ELSE 0 END) AS total_net_balance,

  -- Overdue
  SUM(CASE WHEN nature='debit' AND status='overdue'
           THEN open_amount ELSE 0 END)              AS overdue_amount,
  COUNT(*) FILTER (WHERE nature='debit' AND status='overdue') AS overdue_count,
  MIN(due_date) FILTER (WHERE nature='debit' AND status='overdue') AS oldest_overdue_date

FROM finance.charge c
-- charge não tem deleted_at (sem soft-delete; cancel
-- via status). Filtrar apenas o que faz sentido para "saldo em aberto".
WHERE c.kind = 'receivable'
  AND c.unit_id IS NOT NULL
  AND c.status <> 'cancelled'
GROUP BY c.condominium_id, c.unit_id;

COMMENT ON VIEW finance.balance_unit IS
  'Saldo por (condomínio, fração) considerando apenas receivables. '
  'current_*: débitos com competence ≤ hoje + créditos disponíveis. '
  'future_*: quotas geradas com competence > hoje. '
  'total_*: tudo (visão "se nada mudar"). '
  'net_balance positivo = fração tem crédito.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- finance.balance_supplier - payables por fornecedor (com supplier_id)
-- ═══════════════════════════════════════════════════════════════════════════════

DROP VIEW IF EXISTS finance.balance_supplier;
CREATE VIEW finance.balance_supplier AS
SELECT
  c.condominium_id,
  c.supplier_id,

  -- CURRENT (em payables, "credit" é o que o condo deve)
  SUM(CASE WHEN nature='credit' AND competence_period <= CURRENT_DATE
           THEN open_amount ELSE 0 END)              AS current_open_credit,
  SUM(CASE WHEN nature='debit'
           THEN open_amount ELSE 0 END)              AS current_open_debit,
  SUM(CASE WHEN nature='credit' AND competence_period <= CURRENT_DATE
           THEN open_amount ELSE 0 END)
    - SUM(CASE WHEN nature='debit' THEN open_amount ELSE 0 END) AS current_net_balance,

  -- FUTURE
  SUM(CASE WHEN nature='credit' AND competence_period > CURRENT_DATE
           THEN open_amount ELSE 0 END)              AS future_open_credit,

  -- TOTAL
  SUM(CASE WHEN nature='credit' THEN open_amount ELSE 0 END) AS total_open_credit,
  SUM(CASE WHEN nature='debit'  THEN open_amount ELSE 0 END) AS total_open_debit,
  SUM(CASE WHEN nature='credit' THEN open_amount ELSE 0 END)
    - SUM(CASE WHEN nature='debit' THEN open_amount ELSE 0 END) AS total_net_balance,

  -- Overdue (faturas vencidas e ainda não pagas)
  SUM(CASE WHEN nature='credit' AND status='overdue'
           THEN open_amount ELSE 0 END)              AS overdue_amount,
  COUNT(*) FILTER (WHERE nature='credit' AND status='overdue') AS overdue_count,
  MIN(due_date) FILTER (WHERE nature='credit' AND status='overdue') AS oldest_overdue_date

FROM finance.charge c
WHERE c.kind = 'payable'
  AND c.supplier_id IS NOT NULL
  AND c.status <> 'cancelled'
GROUP BY c.condominium_id, c.supplier_id;

COMMENT ON VIEW finance.balance_supplier IS
  'Saldo por (condomínio, fornecedor) considerando apenas payables com supplier_id. '
  'Payables sem supplier_id (ex.: honorários) ficam fora - consultar finance.charge. '
  'net_balance positivo = condomínio deve ao fornecedor.';
