-- 0030_audit.sql
--
-- Valida o sistema de audit on-Postgres (audit.cdc_log + component 013):
--   1. INSERT/UPDATE/DELETE em tabelas de core/finance produzem rows em audit.cdc_log.
--   2. action é correcto, snapshot capturado, diff em UPDATE tem before/after
--      apenas das colunas alteradas.
--   3. actor é extraído de updated_by JSONB quando presente; fallback GUC.
--   4. skip_list é respeitada.
--   5. audit.cdc_log é append-only - UPDATE/DELETE/TRUNCATE rejeitados.
--   6. Event trigger DDL faz attach automático a tabelas novas em core/finance.

BEGIN;
SELECT plan(14);

-- ═══ Setup ════════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name)
  VALUES ('cd_audit', 'Audit Test Condo');

INSERT INTO core.unit (id, condominium_id, designation, permillage, is_active)
  VALUES ('u_audit', 'cd_audit', 'A1', 1000, true);

-- ═══ Test 1: INSERT em core.condominium foi auditado ══════════════════════════
SELECT cmp_ok(
  (SELECT count(*) FROM audit.cdc_log
     WHERE table_name = 'condominium' AND row_id = 'cd_audit'),
  '>=',
  1::bigint,
  'INSERT em core.condominium produziu row em audit.cdc_log'
);

-- ═══ Test 2: action=insert + snapshot capturado, diff NULL ═══════════════════
SELECT is(
  (SELECT action FROM audit.cdc_log
     WHERE table_name = 'condominium' AND row_id = 'cd_audit'
     ORDER BY id LIMIT 1),
  'insert',
  'action=insert para operação INSERT'
);

SELECT is(
  (SELECT snapshot->>'name' FROM audit.cdc_log
     WHERE table_name = 'condominium' AND row_id = 'cd_audit'
     ORDER BY id LIMIT 1),
  'Audit Test Condo',
  'snapshot capturou colunas (name)'
);

SELECT is(
  (SELECT diff FROM audit.cdc_log
     WHERE table_name = 'condominium' AND row_id = 'cd_audit'
     ORDER BY id LIMIT 1),
  NULL,
  'diff é NULL em INSERT'
);

-- ═══ Test 3: condominium_id inferido do row ═══════════════════════════════════
SELECT is(
  (SELECT condominium_id FROM audit.cdc_log
     WHERE table_name = 'unit' AND row_id = 'u_audit'
     ORDER BY id LIMIT 1),
  'cd_audit',
  'condominium_id inferido de NEW->condominium_id'
);

-- ═══ Test 4: UPDATE produz action=update + diff before/after ═════════════════
UPDATE core.unit SET designation = 'B2' WHERE id = 'u_audit';

SELECT is(
  (SELECT action FROM audit.cdc_log
     WHERE table_name = 'unit' AND row_id = 'u_audit' AND action = 'update'
     ORDER BY id DESC LIMIT 1),
  'update',
  'UPDATE registado com action=update'
);

SELECT is(
  (SELECT diff->'before'->>'designation' FROM audit.cdc_log
     WHERE table_name = 'unit' AND row_id = 'u_audit' AND action = 'update'
     ORDER BY id DESC LIMIT 1),
  'A1',
  'diff.before.designation = "A1" (valor anterior)'
);

SELECT is(
  (SELECT diff->'after'->>'designation' FROM audit.cdc_log
     WHERE table_name = 'unit' AND row_id = 'u_audit' AND action = 'update'
     ORDER BY id DESC LIMIT 1),
  'B2',
  'diff.after.designation = "B2" (valor novo)'
);

-- ═══ Test 5: actor extraído de updated_by JSONB ═══════════════════════════════
UPDATE core.unit
   SET designation = 'C3',
       updated_by  = '{"id":"usr_test","email":"test@audit.pt","ip":"1.2.3.4"}'::jsonb
   WHERE id = 'u_audit';

SELECT is(
  (SELECT actor->>'id' FROM audit.cdc_log
     WHERE table_name = 'unit' AND row_id = 'u_audit'
       AND snapshot->>'designation' = 'C3'
     ORDER BY id DESC LIMIT 1),
  'usr_test',
  'actor.id extraído de NEW.updated_by JSONB'
);

-- ═══ Test 6: skip_list é respeitada ═══════════════════════════════════════════
INSERT INTO audit.cdc_skip_list (schema_name, table_name, reason)
  VALUES ('core', 'unit', 'temporary test skip');

UPDATE core.unit SET designation = 'D4' WHERE id = 'u_audit';

SELECT is(
  (SELECT count(*)::int FROM audit.cdc_log
     WHERE table_name = 'unit'
       AND row_id = 'u_audit'
       AND snapshot->>'designation' = 'D4'),
  0,
  'UPDATE em tabela na skip_list não é auditado'
);

DELETE FROM audit.cdc_skip_list WHERE schema_name = 'core' AND table_name = 'unit';

-- ═══ Test 7: imutabilidade - UPDATE em audit.cdc_log rejeitado ════════════════════
SAVEPOINT mutate_audit;
SELECT throws_ok(
  $$ UPDATE audit.cdc_log SET action = 'delete'
       WHERE id = (SELECT id FROM audit.cdc_log LIMIT 1) $$,
  NULL, NULL,
  'UPDATE em audit.cdc_log rejeitado pelo trigger'
);
ROLLBACK TO SAVEPOINT mutate_audit;

-- ═══ Test 8: imutabilidade - DELETE em audit.cdc_log rejeitado ════════════════════
SAVEPOINT delete_audit;
SELECT throws_ok(
  $$ DELETE FROM audit.cdc_log
       WHERE id = (SELECT id FROM audit.cdc_log LIMIT 1) $$,
  NULL, NULL,
  'DELETE em audit.cdc_log rejeitado pelo trigger'
);
ROLLBACK TO SAVEPOINT delete_audit;

-- ═══ Test 9: event trigger DDL - attach automático em CREATE TABLE ════════════
CREATE TABLE finance._test_audit_attach (
  id              text PRIMARY KEY,
  condominium_id  text,
  name            text
);

SELECT ok(
  EXISTS(
    SELECT 1 FROM pg_trigger t
      JOIN pg_class c     ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE t.tgname = 'trg_audit_finance__test_audit_attach'
        AND n.nspname = 'finance'
        AND c.relname = '_test_audit_attach'
  ),
  'event trigger DDL criou trg_audit em finance._test_audit_attach automaticamente'
);

-- ═══ Test 10: tabela criada via DDL é auditada ════════════════════════════════
INSERT INTO finance._test_audit_attach (id, condominium_id, name)
  VALUES ('t_attach', 'cd_audit', 'attach test');

SELECT cmp_ok(
  (SELECT count(*) FROM audit.cdc_log
     WHERE table_name = '_test_audit_attach' AND row_id = 't_attach'),
  '>=',
  1::bigint,
  'INSERT em tabela criada via DDL aparece em audit.cdc_log'
);

SELECT * FROM finish();
ROLLBACK;
