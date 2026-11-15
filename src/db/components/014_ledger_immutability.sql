-- ═════════════════════════════════════════════════════════════════════════════
-- Component 014: imutabilidade do ledger contabilístico (finance.ledger).
-- Mesma filosofia de audit.cdc_log (013): append-only. Correções via
-- lançamentos de regularização (charge_amount_adjusted, settlement_reversed,
-- charge_cancelled), não UPDATE/DELETE. Exigência legal PT (Código Comercial +
-- SAF-T reproducível).
--
-- Bypass legítimo: seeds (session_replication_role=replica no wipe) e migrations
-- de correção histórica (correm antes dos components). Para
-- correções em produção, migration com DISABLE/ENABLE TRIGGER trg_ledger_no_*.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION finance.fn_reject_ledger_modification()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'finance.ledger é append-only (% rejected on %)',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Lançamentos contabilísticos não podem ser alterados nem '
                 'apagados. Para corrigir, regista um lançamento de regularização '
                 '(novo INSERT com entry_type específico).';
END;
$$;

COMMENT ON FUNCTION finance.fn_reject_ledger_modification() IS
  'Trigger function: rejeita UPDATE/DELETE/TRUNCATE em finance.ledger. '
  'Garantia contabilística - registos imutáveis depois de gravados.';

DROP TRIGGER IF EXISTS trg_ledger_no_update ON finance.ledger;
CREATE TRIGGER trg_ledger_no_update
  BEFORE UPDATE ON finance.ledger
  FOR EACH ROW
  EXECUTE FUNCTION finance.fn_reject_ledger_modification();

DROP TRIGGER IF EXISTS trg_ledger_no_delete ON finance.ledger;
CREATE TRIGGER trg_ledger_no_delete
  BEFORE DELETE ON finance.ledger
  FOR EACH ROW
  EXECUTE FUNCTION finance.fn_reject_ledger_modification();

DROP TRIGGER IF EXISTS trg_ledger_no_truncate ON finance.ledger;
CREATE TRIGGER trg_ledger_no_truncate
  BEFORE TRUNCATE ON finance.ledger
  FOR EACH STATEMENT
  EXECUTE FUNCTION finance.fn_reject_ledger_modification();
