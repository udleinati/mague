-- 0056_occupant_person_type.sql
--
-- Coluna `core.occupant.person_type`. Controla a redação e o
-- rótulo fiscal da procuração da convocatória (singular "Eu, ..." + NIF vs
-- coletiva "A [Empresa] ..." + NIPC). Última linha de defesa: mesmo que o
-- handler TS falhe, a DB garante o par de valores e o backfill implícito.
--
-- Cobre:
--   1. Default 'singular' (backfill implícito dos ocupantes existentes).
--   2. occupant_person_type_check rejeita valores fora de singular|collective.
--   3. 'collective' aceite (empresas).
--   4. NOT NULL real: NULL explícito é rejeitado (23502), não cai no default.

BEGIN;
SELECT plan(4);

-- ═══ Setup ══════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_pt', 'Person type test');

-- ═══ Test 1: default 'singular' quando não se passa person_type ═════════════
INSERT INTO core.occupant (id, condominium_id, name)
  VALUES ('o_default', 'cd_pt', 'Ocupante sem tipo explícito');
SELECT is(
  (SELECT person_type FROM core.occupant WHERE id = 'o_default'),
  'singular',
  'person_type assume default singular (backfill implícito)'
);

-- ═══ Test 2: CHECK bloqueia valores fora do enum (23514) ════════════════════
-- `throws_ok` corre o INSERT no seu próprio subtransaction (bloco EXCEPTION),
-- por isso o erro não aborta esta transação nem deixa resíduo - sem SAVEPOINT.
SELECT throws_ok(
  $$ INSERT INTO core.occupant (id, condominium_id, name, person_type)
     VALUES ('o_bad', 'cd_pt', 'Tipo inválido', 'company') $$,
  '23514',
  NULL,
  'occupant_person_type_check rejeita valor fora de singular|collective'
);

-- ═══ Test 3: 'collective' aceite (pessoa coletiva / empresa) ════════════════
INSERT INTO core.occupant (id, condominium_id, name, person_type)
  VALUES ('o_collective', 'cd_pt', 'Imobiliária X, Lda', 'collective');
SELECT is(
  (SELECT person_type FROM core.occupant WHERE id = 'o_collective'),
  'collective',
  'person_type=collective aceite'
);

-- ═══ Test 4: NOT NULL real - NULL explícito é rejeitado (não cai no default) ═
SELECT throws_ok(
  $$ INSERT INTO core.occupant (id, condominium_id, name, person_type)
     VALUES ('o_null', 'cd_pt', 'Tipo nulo', NULL) $$,
  '23502',
  NULL,
  'person_type NULL explícito viola NOT NULL (não usa o default)'
);

SELECT * FROM finish();
ROLLBACK;
