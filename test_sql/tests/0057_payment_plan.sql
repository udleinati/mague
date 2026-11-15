-- 0057_payment_plan.sql
--
-- Valida a estrutura do plano de pagamento (ADR 0039):
--   • status default 'active' + CHECK dos 4 valores
--   • consistência ended_at vs status (active sem data; terminal com data)
--   • partial unique "1 active por fração" (terminais coexistem; soft-delete liberta)
--   • pelo menos uma nota (partilhada `notes` ou `internal_notes`)
--   • FKs para condominium e unit
--   • audit captura INSERT automaticamente

BEGIN;
SELECT plan(13);

-- ═══ Setup ════════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_pp', 'Payment Plan Test');
INSERT INTO core.unit (id, condominium_id, designation, permillage, is_active)
  VALUES ('u_pp', 'cd_pp', 'A1', 1000, true);
-- Fração sem plano: isola o teste do FK de condominium (test 10) do unique
-- partial "1 active por fração" - u_pp já tem plano active depois do test 7.
INSERT INTO core.unit (id, condominium_id, designation, permillage, is_active)
  VALUES ('u_pp2', 'cd_pp', 'A2', 500, true);

-- ═══ Test 1: INSERT válido cria plano com status default 'active' ═════════════
INSERT INTO core.payment_plan (id, condominium_id, unit_id, notes)
VALUES ('pp_t1', 'cd_pp', 'u_pp', '6 prestações de 200 EUR');

SELECT is(
  (SELECT status FROM core.payment_plan WHERE id = 'pp_t1'),
  'active',
  'INSERT cria plano com status default active'
);

-- ═══ Test 2: status CHECK bloqueia valor inválido ════════════════════════════
SAVEPOINT bad_status;
SELECT throws_ok(
  $$ INSERT INTO core.payment_plan (condominium_id, unit_id, status, notes, ended_at)
     VALUES ('cd_pp', 'u_pp', 'bogus', 'x', now()) $$,
  '23514',
  NULL,
  'CHECK status bloqueia valor fora do enum'
);
ROLLBACK TO bad_status;

-- ═══ Test 3: active com ended_at preenchido viola a consistência ══════════════
SAVEPOINT active_with_ended;
SELECT throws_ok(
  $$ INSERT INTO core.payment_plan (condominium_id, unit_id, status, notes, ended_at)
     VALUES ('cd_pp', 'u_pp', 'active', 'x', now()) $$,
  '23514',
  NULL,
  'active NÃO pode ter ended_at'
);
ROLLBACK TO active_with_ended;

-- ═══ Test 4: terminal sem ended_at viola a consistência ══════════════════════
SAVEPOINT terminal_without_ended;
SELECT throws_ok(
  $$ INSERT INTO core.payment_plan (condominium_id, unit_id, status, notes)
     VALUES ('cd_pp', 'u_pp', 'completed', 'x') $$,
  '23514',
  NULL,
  'estado terminal EXIGE ended_at'
);
ROLLBACK TO terminal_without_ended;

-- ═══ Test 5: 2º plano active na mesma fração viola partial unique ════════════
SAVEPOINT two_active;
SELECT throws_ok(
  $$ INSERT INTO core.payment_plan (condominium_id, unit_id, notes)
     VALUES ('cd_pp', 'u_pp', 'segundo plano') $$,
  '23505',
  NULL,
  'partial unique impede 2 planos active na mesma fração'
);
ROLLBACK TO two_active;

-- ═══ Test 6: plano terminal coexiste com o active (histórico) ═════════════════
INSERT INTO core.payment_plan (id, condominium_id, unit_id, status, notes, ended_at)
VALUES ('pp_hist', 'cd_pp', 'u_pp', 'broken', 'plano antigo em incumprimento', now());

SELECT is(
  (SELECT count(*)::int FROM core.payment_plan WHERE unit_id = 'u_pp' AND deleted_at IS NULL),
  2,
  'terminal + active coexistem (histórico preservado)'
);

-- ═══ Test 7: soft-delete do active liberta o slot para novo active ════════════
UPDATE core.payment_plan SET deleted_at = now(), status = 'cancelled', ended_at = now()
  WHERE id = 'pp_t1';
INSERT INTO core.payment_plan (id, condominium_id, unit_id, notes)
VALUES ('pp_t1b', 'cd_pp', 'u_pp', 'novo plano após soft-delete');

SELECT is(
  (SELECT count(*)::int FROM core.payment_plan
     WHERE unit_id = 'u_pp' AND status = 'active' AND deleted_at IS NULL),
  1,
  'soft-delete remove do partial unique - novo active aceite'
);

-- ═══ Test 8: sem nota nenhuma viola o CHECK ═════════════════════════════════
SAVEPOINT no_note;
SELECT throws_ok(
  $$ INSERT INTO core.payment_plan (condominium_id, unit_id, notes, internal_notes)
     VALUES ('cd_pp', 'u_pp2', NULL, NULL) $$,
  '23514',
  NULL,
  'plano sem nota partilhada nem interna é recusado'
);
ROLLBACK TO no_note;

-- ═══ Test 8b: notas só com espaços contam como vazias ══════════════════════
SAVEPOINT blank_notes;
SELECT throws_ok(
  $$ INSERT INTO core.payment_plan (condominium_id, unit_id, notes, internal_notes)
     VALUES ('cd_pp', 'u_pp2', '   ', ' ') $$,
  '23514',
  NULL,
  'notas só com espaços não contam como nota'
);
ROLLBACK TO blank_notes;

-- ═══ Test 8c: só nota interna é válido (a partilhada é opcional) ═══════════
SAVEPOINT internal_only;
SELECT lives_ok(
  $$ INSERT INTO core.payment_plan (condominium_id, unit_id, internal_notes)
     VALUES ('cd_pp', 'u_pp2', 'ligou a pedir prazo') $$,
  'plano só com nota interna é aceite'
);
ROLLBACK TO internal_only;

-- ═══ Test 9: FK de unit inexistente falha ════════════════════════════════════
SAVEPOINT bad_unit;
SELECT throws_ok(
  $$ INSERT INTO core.payment_plan (condominium_id, unit_id, notes)
     VALUES ('cd_pp', 'u_nope', 'x') $$,
  '23503',
  NULL,
  'FK unit_id rejeita fração inexistente'
);
ROLLBACK TO bad_unit;

-- ═══ Test 10: FK de condominium inexistente falha ════════════════════════════
-- u_pp2 (sem plano active) isola a violação no FK de condominium - se usasse
-- u_pp, o unique partial (1 active/fração) dispararia primeiro (23505).
SAVEPOINT bad_condo;
SELECT throws_ok(
  $$ INSERT INTO core.payment_plan (condominium_id, unit_id, notes)
     VALUES ('cd_nope', 'u_pp2', 'x') $$,
  '23503',
  NULL,
  'FK condominium_id rejeita condomínio inexistente'
);
ROLLBACK TO bad_condo;

-- ═══ Test 11: audit captura o INSERT automaticamente ═════════════════════════
SELECT isnt(
  (SELECT count(*) FROM audit.cdc_log
     WHERE table_name = 'payment_plan' AND row_id = 'pp_hist' AND action = 'insert'),
  0::bigint,
  'audit.cdc_log regista o INSERT em payment_plan (trigger auto-anexado)'
);

SELECT * FROM finish();
ROLLBACK;
