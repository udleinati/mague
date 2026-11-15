-- ═════════════════════════════════════════════════════════════════════════════
-- Pentest pgTAP: audit.cdc_log rejeita UPDATE/DELETE/TRUNCATE e também INSERT
-- directo do owner `mague` (REVOKE FROM PUBLIC não protege o owner; sem isto
-- dava para forjar entradas). O BEFORE INSERT rejeita inserts fora de trigger
-- (pg_trigger_depth() < 2); só audit.fn_log_change (SECURITY DEFINER) insere.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(4);

-- ─── Existing protections (devem continuar a passar) ───────────────────────
SELECT throws_ok(
  $$ UPDATE audit.cdc_log SET action='delete' WHERE id IN (SELECT id FROM audit.cdc_log LIMIT 1) $$,
  NULL,
  'audit.cdc_log is append-only (UPDATE rejected on audit.cdc_log_2026)',
  'UPDATE em audit.cdc_log é rejeitado'
);

SELECT throws_ok(
  $$ DELETE FROM audit.cdc_log WHERE id IN (SELECT id FROM audit.cdc_log LIMIT 1) $$,
  NULL,
  'audit.cdc_log is append-only (DELETE rejected on audit.cdc_log_2026)',
  'DELETE em audit.cdc_log é rejeitado'
);

SELECT throws_ok(
  $$ TRUNCATE audit.cdc_log $$,
  NULL,
  'audit.cdc_log is append-only (TRUNCATE rejected on audit.cdc_log)',
  'TRUNCATE em audit.cdc_log é rejeitado'
);

-- ─── REGRESSION: direct INSERT deve falhar ─────────────────────────────────
-- O INSERT directo (fora de trigger) é rejeitado pelo BEFORE INSERT; aceitá-lo
-- permitiria forjar entradas no audit log.
SELECT throws_ok(
  $$ INSERT INTO audit.cdc_log (table_schema, table_name, row_id, action, actor, snapshot, created_at)
     VALUES ('hack', 'hack_table', 'hack_row', 'insert',
             '{"id":"forged_attacker","email":"victim@example.com"}'::jsonb,
             '{}'::jsonb,
             NOW()) $$,
  NULL,
  NULL,
  'INSERT directo em audit.cdc_log (fora de trigger) deve ser REJEITADO ' ||
    '- audit log forge é vector de adulteração de evidência.'
);

SELECT * FROM finish();
ROLLBACK;
