-- 016_vw_receipt_pending.sql
-- Views auxiliares para emissão de recibos (vw_pending_receipts =
-- tuplas (bank_tx, unit) elegíveis; vw_receipt_emit_data = payload do emit).
--
-- settlement/charge/receipt não têm deleted_at; equivalentes usados abaixo:
--   • s.deleted_at IS NULL    → s.status = 'active'
--   • c.deleted_at IS NULL    → c.status <> 'cancelled'
--   • r.deleted_at IS NULL    → r.voided_at IS NULL
--   • rs.deleted_at IS NULL   → mantém-se (receipt_skip ainda usa deleted_at)

DROP VIEW IF EXISTS finance.vw_pending_receipts;
CREATE VIEW finance.vw_pending_receipts AS
SELECT bt.condominium_id,
       bt.id AS bank_transaction_id,
       COALESCE(s.unit_id, c.unit_id) AS unit_id,
       bt.transaction_date AS payment_date,
       bt.description AS bank_tx_description,
       bt.amount AS bank_tx_amount,
       bt.bank_account_id,
       (SUM(s.amount))::integer AS recipient_amount,
       (COUNT(s.id))::integer AS settlements_count
FROM finance.bank_transaction bt
JOIN finance.settlement s
  ON s.bank_transaction_id = bt.id
 AND s.status = 'active'
LEFT JOIN finance.charge c
  ON c.id = COALESCE(s.debit_charge_id, s.credit_charge_id)
 AND c.status <> 'cancelled'
WHERE bt.amount > 0
  AND COALESCE(bt.status, 'unreconciled') NOT IN ('reversed', 'ignored')
  AND s.settlement_type IN ('bank_reconciliation', 'bank_deposit_credit')
  AND COALESCE(s.unit_id, c.unit_id) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM finance.receipt r
    WHERE r.bank_transaction_id = bt.id
      AND r.unit_id = COALESCE(s.unit_id, c.unit_id)
      AND r.voided_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM finance.receipt_skip rs
    WHERE rs.bank_transaction_id = bt.id
      AND rs.unit_id = COALESCE(s.unit_id, c.unit_id)
      AND rs.deleted_at IS NULL
  )
GROUP BY bt.condominium_id, bt.id, COALESCE(s.unit_id, c.unit_id),
         bt.transaction_date, bt.description, bt.amount, bt.bank_account_id;


-- finance.v_bank_balance - saldos por (condominium, ordinário/FCR/total) a
-- partir de ledger. O ledger não tem deleted_at: é
-- imutável, não há filtro de soft-delete.
DROP VIEW IF EXISTS finance.v_bank_balance;
CREATE VIEW finance.v_bank_balance AS
SELECT condominium_id,
       COALESCE(SUM(CASE WHEN account_code = '121'
                          THEN CASE WHEN direction = 'debit' THEN amount ELSE -amount END
                          ELSE 0 END), 0)::integer AS ordinary_cents,
       COALESCE(SUM(CASE WHEN account_code = '122'
                          THEN CASE WHEN direction = 'debit' THEN amount ELSE -amount END
                          ELSE 0 END), 0)::integer AS fcr_cents,
       COALESCE(SUM(CASE WHEN account_code IN ('121','122')
                          THEN CASE WHEN direction = 'debit' THEN amount ELSE -amount END
                          ELSE 0 END), 0)::integer AS total_cents
FROM finance.ledger
WHERE account_code IN ('121','122')
GROUP BY condominium_id;


-- finance.v_unit_balance - saldos abertos por (condominium, unit). charge não
-- tem deleted_at; as canceladas ficam de fora pelo filtro de status.
DROP VIEW IF EXISTS finance.v_unit_balance;
CREATE VIEW finance.v_unit_balance AS
SELECT c.condominium_id,
       c.unit_id,
       COALESCE(SUM(CASE WHEN c.nature = 'debit'
                          AND c.status IN ('open','partial','overdue')
                          THEN c.open_amount ELSE 0 END), 0)::integer AS open_debt_cents,
       COALESCE(SUM(CASE WHEN c.nature = 'credit'
                          AND c.status IN ('open','partial','overdue')
                          THEN c.open_amount ELSE 0 END), 0)::integer AS open_credit_cents,
       COALESCE(SUM(CASE WHEN c.nature = 'debit'
                          AND c.status IN ('open','partial','overdue')
                          AND c.due_date IS NOT NULL
                          AND cd.reconciled_through_date IS NOT NULL
                          AND c.due_date <= cd.reconciled_through_date
                          THEN c.open_amount ELSE 0 END), 0)::integer AS overdue_debt_cents,
       COALESCE(SUM(CASE WHEN c.status IN ('open','partial','overdue') THEN
                          CASE WHEN c.nature = 'debit' THEN c.open_amount
                               WHEN c.nature = 'credit' THEN -c.open_amount
                               ELSE 0 END
                          ELSE 0 END), 0)::integer AS net_cents
FROM finance.charge c
LEFT JOIN core.condominium cd ON cd.id = c.condominium_id
WHERE c.unit_id IS NOT NULL
  AND c.scope = 'unit'
  AND c.status <> 'cancelled'
GROUP BY c.condominium_id, c.unit_id, cd.reconciled_through_date;


DROP VIEW IF EXISTS finance.vw_receipt_emit_data;
CREATE VIEW finance.vw_receipt_emit_data AS
SELECT bt.condominium_id,
       bt.id AS bank_transaction_id,
       COALESCE(s.unit_id, c.unit_id) AS unit_id,
       bt.transaction_date AS payment_date,
       bt.description AS bank_tx_description,
       bt.amount AS bank_tx_amount,
       ba.bank_name AS bank_account_bank_name,
       ba.account_name AS bank_account_name,
       ba.iban AS bank_account_iban,
       ba.kind AS bank_account_kind,
       s.id AS settlement_id,
       s.amount AS settlement_amount,
       s.settlement_type,
       c.id AS charge_id,
       c.charge_type,
       c.description AS charge_description,
       c.competence_period AS charge_competence_period,
       c.original_amount AS charge_original_amount,
       c.nature AS charge_nature
FROM finance.bank_transaction bt
JOIN finance.settlement s
  ON s.bank_transaction_id = bt.id
 AND s.status = 'active'
LEFT JOIN finance.charge c
  ON c.id = COALESCE(s.debit_charge_id, s.credit_charge_id)
 AND c.status <> 'cancelled'
LEFT JOIN finance.bank_account ba ON ba.id = bt.bank_account_id
WHERE s.settlement_type IN ('bank_reconciliation', 'bank_deposit_credit')
  AND COALESCE(s.unit_id, c.unit_id) IS NOT NULL;
