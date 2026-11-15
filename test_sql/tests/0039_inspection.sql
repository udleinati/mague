-- 0039_inspection.sql
--
-- Valida estrutura básica do módulo de inspeções:
--   • Constraint de category (apenas valores válidos da lista)
--   • Constraint de notify_days_before (0..365)
--   • INSERT com defaults razoáveis (notify_days_before = 30)
--   • last_done_date NULLable, valid_until NOT NULL
--   • Soft-delete preserva row e exclui dos índices
--   • Audit captura INSERT/UPDATE em inspection automaticamente

BEGIN;
SELECT plan(12);

-- ═══ Setup ════════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_insp', 'Inspection Test');

-- ═══ Test 1: INSERT mínimo aplica default notify_days_before=30 ═══════════════
INSERT INTO core.inspection (id, condominium_id, category, description, valid_until, created_by)
VALUES ('insp_t1', 'cd_insp', 'fire_extinguisher', 'Extintores prédio',
        '2099-12-31', '{"id":"usr_test","email":"u@x.pt"}'::jsonb);

SELECT is(
  (SELECT notify_days_before FROM core.inspection WHERE id='insp_t1'),
  30,
  'INSERT mínimo: notify_days_before default = 30'
);

SELECT is(
  (SELECT last_done_date FROM core.inspection WHERE id='insp_t1'),
  NULL::date,
  'last_done_date é NULL por defeito (obrigação ainda não cumprida)'
);

-- ═══ Test 2: category check bloqueia valores fora da lista ═══════════════════
SAVEPOINT bad_cat;
SELECT throws_ok(
  $$ INSERT INTO core.inspection (condominium_id, category, description, valid_until, created_by)
     VALUES ('cd_insp', 'bogus_cat', 'X', '2099-01-01', '{"id":"u"}'::jsonb) $$,
  '23514',
  NULL,
  'CHECK category bloqueia "bogus_cat"'
);
ROLLBACK TO SAVEPOINT bad_cat;

-- ═══ Test 3: notify_days_before fora de [0..365] bloqueia ═════════════════════
SAVEPOINT bad_notify_neg;
SELECT throws_ok(
  $$ INSERT INTO core.inspection (condominium_id, category, description, valid_until,
                                    notify_days_before, created_by)
     VALUES ('cd_insp', 'gas', 'X', '2099-01-01', -1, '{"id":"u"}'::jsonb) $$,
  '23514',
  NULL,
  'CHECK notify_days_before bloqueia negativos'
);
ROLLBACK TO SAVEPOINT bad_notify_neg;

SAVEPOINT bad_notify_high;
SELECT throws_ok(
  $$ INSERT INTO core.inspection (condominium_id, category, description, valid_until,
                                    notify_days_before, created_by)
     VALUES ('cd_insp', 'gas', 'X', '2099-01-01', 366, '{"id":"u"}'::jsonb) $$,
  '23514',
  NULL,
  'CHECK notify_days_before bloqueia > 365'
);
ROLLBACK TO SAVEPOINT bad_notify_high;

-- ═══ Test 4: valid_until NOT NULL ═════════════════════════════════════════════
SAVEPOINT no_valid;
SELECT throws_ok(
  $$ INSERT INTO core.inspection (condominium_id, category, description, created_by)
     VALUES ('cd_insp', 'gas', 'X', '{"id":"u"}'::jsonb) $$,
  '23502',
  NULL,
  'NOT NULL valid_until rejeita INSERT sem data'
);
ROLLBACK TO SAVEPOINT no_valid;

-- ═══ Test 5: UPDATE actualiza in-place (modelo "obrigação periódica") ═════════
UPDATE core.inspection
   SET last_done_date = '2026-04-15',
       valid_until = '2027-04-15',
       notify_days_before = 60,
       updated_by = '{"id":"usr_test"}'::jsonb,
       updated_at = now()
 WHERE id = 'insp_t1';

SELECT is(
  (SELECT last_done_date FROM core.inspection WHERE id='insp_t1'),
  '2026-04-15'::date,
  'UPDATE: last_done_date persistido'
);

SELECT is(
  (SELECT notify_days_before FROM core.inspection WHERE id='insp_t1'),
  60,
  'UPDATE: notify_days_before persistido'
);

-- ═══ Test 6: audit captou INSERT + UPDATE ═════════════════════════════════════
SELECT cmp_ok(
  (SELECT count(*)::int FROM audit.cdc_log
     WHERE table_schema='core' AND table_name='inspection' AND row_id='insp_t1'),
  '>=',
  2,
  'audit.cdc_log capturou INSERT + UPDATE'
);

SELECT is(
  (SELECT diff->'after'->>'valid_until' FROM audit.cdc_log
     WHERE table_name='inspection' AND row_id='insp_t1' AND action='update'
     ORDER BY id DESC LIMIT 1),
  '2027-04-15',
  'diff.after.valid_until reflete renovação'
);

-- ═══ Test 7: soft delete preserva row, exclui do index parcial ════════════════
UPDATE core.inspection
   SET deleted_at = now(),
       deleted_by = '{"id":"usr_test"}'::jsonb
 WHERE id = 'insp_t1';

SELECT cmp_ok(
  (SELECT count(*)::int FROM core.inspection WHERE id='insp_t1'),
  '=',
  1,
  'soft delete: row continua na tabela'
);

-- Index parcial WHERE deleted_at IS NULL → query "ativos" não devolve.
SELECT is(
  (SELECT count(*)::int FROM core.inspection
     WHERE condominium_id='cd_insp' AND deleted_at IS NULL),
  0,
  'soft delete: query com deleted_at IS NULL não devolve a row'
);

SELECT * FROM finish();
ROLLBACK;
