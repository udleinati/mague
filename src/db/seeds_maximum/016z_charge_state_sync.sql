-- 016z_charge_state_sync.sql - propaga state de settlements para charges.
-- Pós ADR 0001, fn_settlement_ai só emite ledger; os efeitos em
-- charge.{settled_amount,open_amount,amount,status} vivem em TS
-- (applySettlementEffects). Os seeds 015/016 inserem settlements direto em SQL,
-- bypassando esse orchestrator - este ficheiro corre o equivalente em bulk.
-- Manter em sync com effects_math.ts / charge_status.ts:
--   • settled_amount = Σ debit settlements − Σ credit
--   • open_amount    = MAX(expected_amount - settled_amount, 0)
--   • status         = paid | partial | overdue | open; cancelled/disputed intactos.

WITH agg AS (
  SELECT
    c.id AS charge_id,
    c.expected_amount,
    c.original_amount,
    c.due_date,
    c.status AS current_status,
    -- Settlement contribuirá positivamente quando a charge é o lado debit,
    -- negativamente quando é o lado credit (bank_reconciliation só pode
    -- ter um dos dois NOT NULL).
    COALESCE(SUM(
      CASE
        WHEN s.debit_charge_id = c.id THEN s.amount
        WHEN s.credit_charge_id = c.id THEN -s.amount
        ELSE 0
      END
    ), 0)::int AS new_settled
  FROM finance.charge c
  JOIN finance.settlement s
    ON (s.debit_charge_id = c.id OR s.credit_charge_id = c.id)
   AND s.status = 'active'
   AND s.settlement_type = 'bank_reconciliation'
  WHERE c.condominium_id LIKE 'condo_max_%'
  GROUP BY c.id, c.expected_amount, c.original_amount, c.due_date, c.status
)
UPDATE finance.charge c
   SET
     settled_amount = agg.new_settled,
     amount = agg.new_settled,
     open_amount = GREATEST(agg.expected_amount - agg.new_settled, 0),
     status = CASE
       WHEN agg.current_status IN ('cancelled', 'disputed') THEN agg.current_status
       WHEN GREATEST(agg.expected_amount - agg.new_settled, 0) <= 0 THEN 'paid'
       WHEN agg.new_settled > 0 THEN 'partial'
       WHEN agg.due_date IS NOT NULL AND agg.due_date < CURRENT_DATE THEN 'overdue'
       ELSE 'open'
     END
  FROM agg
 WHERE c.id = agg.charge_id;
