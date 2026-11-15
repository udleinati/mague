-- 0059_pathology_lifecycle.sql
--
-- Atribuicao de codigo e invariantes de ciclo de vida da patologia
-- (core.pathology, component 017):
--   • trg_pathology_code_assign: code = 'P' + base36, sequencial per-condominio
--   • idempotente: code explicito do caller e respeitado (nao sobrepoe)
--   • pathology_code_format: code tem de casar ^P[0-9A-Z]{3,}$
--   • pathology_status_check / pathology_category_check: enums
--   • pathology_dismissed_reason_required: dismissed exige reason + dismissed_at
--   • pathology_resolved_at_required: resolved exige resolved_at
--
-- Nota: throws_ok apanha a excecao numa subtransacao interna, por isso nao
-- precisa de SAVEPOINT externo (a tx sobrevive na mesma).

BEGIN;
SELECT plan(11);

-- ═══ Setup: condominio fresco (counter de codigo arranca em 1) ════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_path', 'Pathology Test');

-- ═══ Test 1: 1.a patologia recebe P001 ════════════════════════════════════════
INSERT INTO core.pathology (id, condominium_id, title, category)
  VALUES ('pa_1', 'cd_path', 'Fissura fachada norte', 'crack');
SELECT is(
  (SELECT code FROM core.pathology WHERE id='pa_1'),
  'P001',
  'trigger atribui P001 a primeira patologia do condominio'
);

-- ═══ Test 2: 2.a patologia incrementa para P002 ═══════════════════════════════
INSERT INTO core.pathology (id, condominium_id, title, category)
  VALUES ('pa_2', 'cd_path', 'Infiltracao garagem', 'infiltration');
SELECT is(
  (SELECT code FROM core.pathology WHERE id='pa_2'),
  'P002',
  'sequencia per-condominio incrementa (P002)'
);

-- ═══ Test 3: code explicito do caller e respeitado (idempotencia) ═════════════
INSERT INTO core.pathology (id, condominium_id, title, category, code)
  VALUES ('pa_3', 'cd_path', 'Import legado', 'other', 'PABC');
SELECT is(
  (SELECT code FROM core.pathology WHERE id='pa_3'),
  'PABC',
  'code explicito nao e sobreposto pelo trigger'
);

-- ═══ Test 4: counter reflete apenas os codigos auto-atribuidos ════════════════
SELECT is(
  (SELECT last_number FROM core.pathology_code_counter WHERE condominium_id='cd_path'),
  2,
  'counter=2 (override explicito nao consome sequencia)'
);

-- ═══ Test 5: category fora do enum bloqueado ══════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.pathology (condominium_id, title, category)
     VALUES ('cd_path', 'X', 'bogus') $$,
  '23514',
  NULL,
  'pathology_category_check rejeita categoria invalida'
);

-- ═══ Test 6: status fora do enum bloqueado ════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.pathology (condominium_id, title, category, status)
     VALUES ('cd_path', 'X', 'crack', 'bogus') $$,
  '23514',
  NULL,
  'pathology_status_check rejeita status invalido'
);

-- ═══ Test 7: dismissed sem reason/dismissed_at bloqueado ══════════════════════
SELECT throws_ok(
  $$ UPDATE core.pathology SET status='dismissed' WHERE id='pa_1' $$,
  '23514',
  NULL,
  'pathology_dismissed_reason_required exige reason + dismissed_at'
);

-- ═══ Test 8: dismissed completo aceite ════════════════════════════════════════
SELECT lives_ok(
  $$ UPDATE core.pathology
       SET status='dismissed', dismissed_reason='falso positivo', dismissed_at=CURRENT_DATE
     WHERE id='pa_1' $$,
  'dismissed com reason + dismissed_at e aceite'
);

-- ═══ Test 9: resolved sem resolved_at bloqueado ═══════════════════════════════
SELECT throws_ok(
  $$ UPDATE core.pathology SET status='resolved' WHERE id='pa_2' $$,
  '23514',
  NULL,
  'pathology_resolved_at_required exige resolved_at'
);

-- ═══ Test 10: resolved com resolved_at aceite ═════════════════════════════════
SELECT lives_ok(
  $$ UPDATE core.pathology SET status='resolved', resolved_at=CURRENT_DATE WHERE id='pa_2' $$,
  'resolved com resolved_at e aceite'
);

-- ═══ Test 11: code com formato invalido bloqueado ════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.pathology (condominium_id, title, category, code)
     VALUES ('cd_path', 'X', 'crack', 'X1') $$,
  '23514',
  NULL,
  'pathology_code_format rejeita code que nao casa ^P[0-9A-Z]{3,}$'
);

SELECT * FROM finish();
ROLLBACK;
