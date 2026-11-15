-- ═════════════════════════════════════════════════════════════════════════════
-- pgTAP: imutabilidade de finance.ledger (component 014).
--
-- Lançamentos contabilísticos são append-only - UPDATE/DELETE/TRUNCATE
-- rejeitados por triggers `trg_ledger_no_*`. Correcções fazem-se via
-- novos INSERTs com entry_type específico (lançamentos de regularização).
--
-- INSERT continua a funcionar normalmente (testado implicitamente em
-- 0002, 0003, 0007, 0008, etc - todos esses fazem inserts via fn_charge_ai
-- e fn_settlement_ai).
--
-- Bypass legítimo (testado também aqui): `SET session_replication_role =
-- replica` desactiva os triggers de utilizador. Usado em wipe scripts de
-- seed; não disponível ao role aplicacional em produção.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(5);

-- ─── Setup: insere 1 entrada de ledger para tentar mexer ───────────────────
-- INSERT é permitido (não restrito).
INSERT INTO core.condominium (id, name, designation_type, address)
VALUES ('_ledim_condo', 'Ledger Imm Test', 'condominium', 'Rua T');

INSERT INTO core.unit (id, condominium_id, designation, permillage)
VALUES ('_ledim_unit', '_ledim_condo', 'A', 100);

INSERT INTO finance.ledger (id, condominium_id, unit_id, entity_type, entry_date,
  entry_type, account_code, direction, amount, description, ref_type, ref_id)
VALUES ('_ledim_entry', '_ledim_condo', '_ledim_unit', 'condominium', CURRENT_DATE,
  'manual_test', '121', 'debit', 1000, 'Teste imutabilidade', 'test', 'test_id');

-- ─── (1) UPDATE rejeitado ──────────────────────────────────────────────────
SELECT throws_ok(
  $$ UPDATE finance.ledger SET amount = 9999 WHERE id = '_ledim_entry' $$,
  NULL,
  'finance.ledger é append-only (UPDATE rejected on ledger)',
  'UPDATE em finance.ledger é rejeitado pelo trigger trg_ledger_no_update'
);

-- ─── (2) DELETE rejeitado ──────────────────────────────────────────────────
SELECT throws_ok(
  $$ DELETE FROM finance.ledger WHERE id = '_ledim_entry' $$,
  NULL,
  'finance.ledger é append-only (DELETE rejected on ledger)',
  'DELETE em finance.ledger é rejeitado pelo trigger trg_ledger_no_delete'
);

-- ─── (3) TRUNCATE rejeitado ────────────────────────────────────────────────
SELECT throws_ok(
  $$ TRUNCATE finance.ledger $$,
  NULL,
  'finance.ledger é append-only (TRUNCATE rejected on ledger)',
  'TRUNCATE em finance.ledger é rejeitado pelo trigger trg_ledger_no_truncate'
);

-- ─── (4) INSERT continua a funcionar ───────────────────────────────────────
INSERT INTO finance.ledger (id, condominium_id, unit_id, entity_type, entry_date,
  entry_type, account_code, direction, amount, description, ref_type, ref_id)
VALUES ('_ledim_entry2', '_ledim_condo', '_ledim_unit', 'condominium', CURRENT_DATE,
  'regularization', '121', 'credit', 1000, 'Lançamento regularização', 'test', 'test_id');

SELECT is(
  (SELECT count(*)::int FROM finance.ledger WHERE ref_id='test_id'),
  2,
  'INSERT (incl. lançamento de regularização) continua a funcionar normalmente'
);

-- ─── (5) Bypass via session_replication_role = replica ─────────────────────
-- Único caminho legítimo de fazer UPDATE/DELETE: desactivar triggers a
-- nível de sessão. Usado em wipe scripts. Em produção não está disponível
-- ao role da app (nem deve).
SET LOCAL session_replication_role = replica;
DELETE FROM finance.ledger WHERE ref_id = 'test_id';
SET LOCAL session_replication_role = origin;

SELECT is(
  (SELECT count(*)::int FROM finance.ledger WHERE ref_id='test_id'),
  0,
  'Bypass via session_replication_role=replica funciona (caso de wipe seed)'
);

-- ─── Cleanup ──────────────────────────────────────────────────────────────
SET session_replication_role = replica;
DELETE FROM core.unit WHERE id='_ledim_unit';
DELETE FROM core.condominium WHERE id='_ledim_condo';

SELECT * FROM finish();
ROLLBACK;
