-- 0055_assembly_convocation.sql
--
-- Constraints da tabela `core.assembly_convocation`. Última linha de defesa:
-- mesmo que o handler TS falhe, a DB rejeita um `trigger` inválido.
--
-- Cobre:
--   1. assembly_convocation_trigger_check IN ('individual', 'bulk').
--   2. inserts válidos (bulk + individual) aceites.
--   3. recipients tem default '[]'::jsonb; snapshot é nullable.

BEGIN;
SELECT plan(5);

-- ═══ Setup ════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_cv', 'Convocation constraint test');
INSERT INTO core.assembly (id, condominium_id, type, scheduled_at)
  VALUES ('a_cv', 'cd_cv', 'ordinary', '2026-07-10 19:00:00+00');

-- ═══ Test 1: trigger bloqueia valores fora do enum (23514) ══════════════════
SAVEPOINT bad_trigger;
SELECT throws_ok(
  $$ INSERT INTO core.assembly_convocation (assembly_id, condominium_id, trigger, sent_by)
     VALUES ('a_cv', 'cd_cv', 'broadcast', '{}'::jsonb) $$,
  '23514',
  NULL,
  'assembly_convocation_trigger_check rejeita trigger fora de individual|bulk'
);
ROLLBACK TO SAVEPOINT bad_trigger;

-- ═══ Test 2: trigger='bulk' aceite ══════════════════════════════════════════
INSERT INTO core.assembly_convocation (id, assembly_id, condominium_id, trigger, sent_by)
  VALUES ('ac_bulk', 'a_cv', 'cd_cv', 'bulk', '{}'::jsonb);
SELECT ok(true, 'trigger=bulk aceite');

-- ═══ Test 3: trigger='individual' aceite ════════════════════════════════════
INSERT INTO core.assembly_convocation (id, assembly_id, condominium_id, trigger, sent_by)
  VALUES ('ac_indiv', 'a_cv', 'cd_cv', 'individual', '{}'::jsonb);
SELECT ok(true, 'trigger=individual aceite');

-- ═══ Test 4: recipients default '[]' ════════════════════════════════════════
SELECT is(
  (SELECT recipients FROM core.assembly_convocation WHERE id='ac_bulk'),
  '[]'::jsonb,
  'recipients assume default vazio []'
);

-- ═══ Test 5: snapshot é nullable (envio sem snapshot não rebenta) ═══════════
SELECT is(
  (SELECT snapshot FROM core.assembly_convocation WHERE id='ac_bulk'),
  NULL,
  'snapshot é nullable (NULL por omissão)'
);

SELECT * FROM finish();
ROLLBACK;
