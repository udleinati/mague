-- 0054_receipt_skip_idempotency.sql
--
-- `finance.receipt_skip` tem unique partial index `idx_receipt_skip_active_uniq`
-- ON (bank_transaction_id, unit_id) WHERE deleted_at IS NULL.
--
-- Garante:
--   1. Inserir 2x mesma tupla (bt, unit) com deleted_at IS NULL → 23505.
--   2. Soft-delete (deleted_at NOT NULL) liberta a constraint → permite
--      novo skip da mesma tupla (lifecycle skip → unskip → skip).
--   3. 2 unidades diferentes para o mesmo bank_tx → aceite (multi-allocation).

BEGIN;
SELECT plan(5);

-- ═══ Setup ════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_rs', 'Receipt skip test');
INSERT INTO core.unit (id, condominium_id, designation, permillage)
  VALUES ('u_rs_a', 'cd_rs', 'A', 500), ('u_rs_b', 'cd_rs', 'B', 500);
INSERT INTO finance.bank_account (id, condominium_id, bank_name, kind)
  VALUES ('ba_rs', 'cd_rs', 'X', 'bank');
INSERT INTO finance.bank_transaction
  (id, condominium_id, bank_account_id, transaction_date, description, amount)
VALUES
  ('bt_rs1', 'cd_rs', 'ba_rs', '2026-03-01', 'tx1', 10000),
  ('bt_rs2', 'cd_rs', 'ba_rs', '2026-03-02', 'tx2', 20000);

-- ═══ Test 1: 1º skip aceite ══════════════════════════════════════════════
INSERT INTO finance.receipt_skip
  (id, condominium_id, bank_transaction_id, unit_id, skipped_by)
VALUES ('rs1', 'cd_rs', 'bt_rs1', 'u_rs_a', '{"id":"sys","name":"sys"}'::jsonb);

SELECT is(
  (SELECT count(*)::int FROM finance.receipt_skip
    WHERE bank_transaction_id='bt_rs1' AND unit_id='u_rs_a' AND deleted_at IS NULL),
  1,
  'primeiro skip ativo registado'
);

-- ═══ Test 2: 2º skip mesma tupla → bloqueado pelo unique partial ════════
SAVEPOINT dup_skip;
SELECT throws_ok(
  $$ INSERT INTO finance.receipt_skip
       (condominium_id, bank_transaction_id, unit_id, skipped_by)
     VALUES ('cd_rs', 'bt_rs1', 'u_rs_a', '{"id":"sys"}'::jsonb) $$,
  '23505',
  NULL,
  'unique partial bloqueia 2 skips ativos para mesma (bt, unit)'
);
ROLLBACK TO SAVEPOINT dup_skip;

-- ═══ Test 3: outra unit para mesmo bt → aceite (multi-allocation) ═══════
INSERT INTO finance.receipt_skip
  (id, condominium_id, bank_transaction_id, unit_id, skipped_by)
VALUES ('rs2', 'cd_rs', 'bt_rs1', 'u_rs_b', '{"id":"sys"}'::jsonb);

SELECT is(
  (SELECT count(*)::int FROM finance.receipt_skip
    WHERE bank_transaction_id='bt_rs1' AND deleted_at IS NULL),
  2,
  'mesmo bt + units diferentes: 2 skips ativos (allocation parcial)'
);

-- ═══ Test 4: soft-delete liberta constraint - novo skip aceite ══════════
UPDATE finance.receipt_skip SET deleted_at=now() WHERE id='rs1';
INSERT INTO finance.receipt_skip
  (id, condominium_id, bank_transaction_id, unit_id, skipped_by)
VALUES ('rs1b', 'cd_rs', 'bt_rs1', 'u_rs_a', '{"id":"sys"}'::jsonb);

SELECT is(
  (SELECT count(*)::int FROM finance.receipt_skip
    WHERE bank_transaction_id='bt_rs1' AND unit_id='u_rs_a' AND deleted_at IS NULL),
  1,
  'após unskip (soft-delete), novo skip da mesma (bt, unit) é aceite'
);

-- E o registo histórico ficou preservado:
SELECT is(
  (SELECT count(*)::int FROM finance.receipt_skip
    WHERE bank_transaction_id='bt_rs1' AND unit_id='u_rs_a'),
  2,
  'preserva histórico: 1 soft-deleted + 1 ativo na mesma tupla'
);

SELECT * FROM finish();
ROLLBACK;
