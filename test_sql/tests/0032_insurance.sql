-- 0032_insurance.sql
--
-- Valida estrutura básica do módulo de seguros:
--   • Constraint de status (apenas 3 valores válidos)
--   • Constraint de trigger (individual|bulk)
--   • Soft-delete preserva row e exclui dos índices
--   • Audit captura INSERT/UPDATE em insurance_policy automaticamente
--   • FKs para condominium e unit funcionam
--   • Linhagem de renovação renewed_from_id: FK self ON DELETE RESTRICT (ADR 0040)

BEGIN;
SELECT plan(14);

-- ═══ Setup ════════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_ins', 'Insurance Test');
INSERT INTO core.unit (id, condominium_id, designation, permillage, is_active)
  VALUES ('u_ins', 'cd_ins', 'A1', 1000, true);

-- ═══ Test 1: INSERT válido cria policy em pending_review ══════════════════════
-- A apólice não tem `storage_key` (ficheiros vivem em
-- `core.attachment` polimórfica). `valid_from`/`valid_to` são NOT NULL.
INSERT INTO core.insurance_policy (id, condominium_id, unit_id, valid_from, valid_to, uploaded_by)
VALUES ('pol_t1', 'cd_ins', 'u_ins', '2026-01-01', '2027-01-01',
        '{"id":"usr_test","email":"u@x.pt"}'::jsonb);

SELECT is(
  (SELECT status FROM core.insurance_policy WHERE id='pol_t1'),
  'pending_review',
  'INSERT cria policy com status default pending_review'
);

-- ═══ Test 2: status check bloqueia valores inválidos ══════════════════════════
SAVEPOINT bad_status;
SELECT throws_ok(
  $$ INSERT INTO core.insurance_policy (condominium_id, unit_id, valid_from, valid_to, status, uploaded_by)
     VALUES ('cd_ins', 'u_ins', '2026-01-01', '2027-01-01', 'bogus', '{"id":"u"}'::jsonb) $$,
  '23514',
  NULL,
  'CHECK status bloqueia "bogus"'
);
ROLLBACK TO SAVEPOINT bad_status;

-- ═══ Test 3: UPDATE para active funciona ══════════════════════════════════════
UPDATE core.insurance_policy
   SET status = 'active', valid_to = '2027-01-01',
       confirmed_at = now(),
       confirmed_by = '{"id":"usr_test"}'::jsonb,
       updated_by = '{"id":"usr_test"}'::jsonb
 WHERE id = 'pol_t1';
SELECT is(
  (SELECT status FROM core.insurance_policy WHERE id='pol_t1'),
  'active',
  'UPDATE para active aceite'
);

-- ═══ Test 4: audit registou INSERT + UPDATE ═══════════════════════════════════
SELECT cmp_ok(
  (SELECT count(*)::int FROM audit.cdc_log
     WHERE table_name='insurance_policy' AND row_id='pol_t1'),
  '>=',
  2,
  'audit.cdc_log capturou INSERT + UPDATE'
);

SELECT is(
  (SELECT diff->'after'->>'status' FROM audit.cdc_log
     WHERE table_name='insurance_policy' AND row_id='pol_t1' AND action='update'
     ORDER BY id DESC LIMIT 1),
  'active',
  'diff.after.status = "active" no UPDATE'
);

-- ═══ Test 5: rejection flow ═══════════════════════════════════════════════════
INSERT INTO core.insurance_policy (id, condominium_id, unit_id, valid_from, valid_to, uploaded_by)
VALUES ('pol_rej', 'cd_ins', 'u_ins', '2026-01-01', '2027-01-01',
        '{"id":"usr_test"}'::jsonb);

UPDATE core.insurance_policy
   SET status='rejected', rejected_at = now(),
       rejected_by = '{"id":"usr_admin"}'::jsonb,
       rejected_reason = 'PDF ilegível'
 WHERE id='pol_rej';

SELECT is(
  (SELECT rejected_reason FROM core.insurance_policy WHERE id='pol_rej'),
  'PDF ilegível',
  'rejected_reason persistido'
);

-- ═══ Test 6: insurance_reminder constraint trigger ═══════════════════════════
INSERT INTO core.insurance_reminder (condominium_id, unit_id, trigger, sent_by)
VALUES ('cd_ins', 'u_ins', 'individual', '{"id":"usr_admin"}'::jsonb);

SAVEPOINT bad_trigger;
SELECT throws_ok(
  $$ INSERT INTO core.insurance_reminder (condominium_id, unit_id, trigger, sent_by)
     VALUES ('cd_ins', 'u_ins', 'invalid', '{"id":"u"}'::jsonb) $$,
  '23514',
  NULL,
  'CHECK trigger bloqueia valor inválido'
);
ROLLBACK TO SAVEPOINT bad_trigger;

-- ═══ Test 7: índice "atual" privilegia valid_to mais distante ═══════════════
INSERT INTO core.insurance_policy (id, condominium_id, unit_id,
  status, valid_from, valid_to, uploaded_by)
VALUES ('pol_old', 'cd_ins', 'u_ins', 'active', '2025-01-01', '2026-12-31', '{"id":"u"}'::jsonb),
       ('pol_new', 'cd_ins', 'u_ins', 'active', '2025-01-01', '2027-12-31', '{"id":"u"}'::jsonb);

-- Não existe coluna `deleted_at` em
-- insurance_policy - soft-delete não é a convenção (audit via cdc_log).
SELECT is(
  (SELECT id FROM core.insurance_policy
     WHERE unit_id='u_ins' AND status='active'
     ORDER BY valid_to DESC LIMIT 1),
  'pol_new',
  'query "atual" devolve a com valid_to mais distante'
);

-- ═══ Test 8: coluna renewed_from_id existe e é text ═══════════════════════════
-- text, não uuid: insurance_policy.id é public.nanoid(10) (text).
SELECT has_column('core', 'insurance_policy', 'renewed_from_id',
  'insurance_policy tem coluna renewed_from_id');
SELECT col_type_is('core', 'insurance_policy', 'renewed_from_id', 'text',
  'renewed_from_id é text (espelha o tipo de id)');

-- ═══ Test 9: FK self-reference é ON DELETE RESTRICT ═══════════════════════════
-- confdeltype: 'r'=RESTRICT, 'a'=NO ACTION, 'c'=CASCADE, 'n'=SET NULL.
SELECT is(
  (SELECT confdeltype::text FROM pg_constraint
     WHERE conname = 'insurance_policy_renewed_from_fk'),
  'r',
  'FK renewed_from_id existe e é ON DELETE RESTRICT'
);

-- ═══ Test 10: renewed_from_id inexistente é rejeitado pela FK ═════════════════
SAVEPOINT bad_fk;
SELECT throws_ok(
  $$ INSERT INTO core.insurance_policy
       (condominium_id, unit_id, valid_from, valid_to, uploaded_by, renewed_from_id)
     VALUES ('cd_ins', 'u_ins', '2026-01-01', '2027-01-01', '{"id":"u"}'::jsonb, 'pol_nao_existe') $$,
  '23503',
  NULL,
  'FK bloqueia renewed_from_id que não aponta para apólice real'
);
ROLLBACK TO SAVEPOINT bad_fk;

-- ═══ Test 11+12: ON DELETE RESTRICT - a linhagem não quebra em silêncio ═══════
-- Predecessor + sucessora que o referencia (caminho admin renew).
INSERT INTO core.insurance_policy
  (id, condominium_id, unit_id, status, valid_from, valid_to, uploaded_by)
VALUES ('pol_pred', 'cd_ins', 'u_ins', 'superseded', '2025-01-01', '2026-01-01', '{"id":"u"}'::jsonb);
INSERT INTO core.insurance_policy
  (id, condominium_id, unit_id, status, valid_from, valid_to, uploaded_by, renewed_from_id)
VALUES ('pol_succ', 'cd_ins', 'u_ins', 'active', '2026-01-01', '2027-01-01', '{"id":"u"}'::jsonb, 'pol_pred');

-- Apagar o predecessor referenciado falha: o admin tem de apagar a sucessora primeiro.
SAVEPOINT restrict_del;
SELECT throws_ok(
  $$ DELETE FROM core.insurance_policy WHERE id='pol_pred' $$,
  '23001',
  NULL,
  'ON DELETE RESTRICT bloqueia apagar predecessor com sucessora'
);
ROLLBACK TO SAVEPOINT restrict_del;

-- Apagar a sucessora primeiro e depois o predecessor passa (cadeia limpa).
DELETE FROM core.insurance_policy WHERE id='pol_succ';
DELETE FROM core.insurance_policy WHERE id='pol_pred';
SELECT is(
  (SELECT count(*)::int FROM core.insurance_policy WHERE id IN ('pol_pred','pol_succ')),
  0,
  'apagar sucessora -> predecessor limpa a cadeia inteira'
);

SELECT * FROM finish();
ROLLBACK;
