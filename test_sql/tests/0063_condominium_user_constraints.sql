-- 0063_condominium_user_constraints.sql
--
-- Invariantes de schema do condominio e do utilizador:
--   • condominiums_quota_day_check: quota_day_of_month em [1..28]
--   • condominiums_fiscal_month_check: fiscal_year_start_month em [1..12]
--   • condominium_designation_type_check: building|condominium
--   • users_email_active_uq: email unico entre utilizadores ATIVOS (parcial
--     WHERE deleted_at IS NULL) - permite re-registo do mesmo email apos
--     soft-delete.
--
-- Nota: throws_ok apanha a excecao numa subtransacao interna, por isso nao
-- precisa de SAVEPOINT externo.

BEGIN;
SELECT plan(7);

-- ═══ Test 1: quota_day_of_month = 0 bloqueado ═════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.condominium (name, quota_day_of_month) VALUES ('X', 0) $$,
  '23514',
  NULL,
  'condominiums_quota_day_check rejeita dia 0'
);

-- ═══ Test 2: quota_day_of_month = 29 bloqueado ════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.condominium (name, quota_day_of_month) VALUES ('X', 29) $$,
  '23514',
  NULL,
  'condominiums_quota_day_check rejeita dia 29'
);

-- ═══ Test 3: fiscal_year_start_month = 0 bloqueado ════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.condominium (name, fiscal_year_start_month) VALUES ('X', 0) $$,
  '23514',
  NULL,
  'condominiums_fiscal_month_check rejeita mes 0'
);

-- ═══ Test 4: fiscal_year_start_month = 13 bloqueado ═══════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.condominium (name, fiscal_year_start_month) VALUES ('X', 13) $$,
  '23514',
  NULL,
  'condominiums_fiscal_month_check rejeita mes 13'
);

-- ═══ Test 5: designation_type invalido bloqueado ════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.condominium (name, designation_type) VALUES ('X', 'tower') $$,
  '23514',
  NULL,
  'condominium_designation_type_check rejeita valor fora de building|condominium'
);

-- ═══ Test 6: 2 utilizadores ativos com mesmo email bloqueado ══════════════════
INSERT INTO core."user" (id, email) VALUES ('us_a', 'dup@mague.pt');
SELECT throws_ok(
  $$ INSERT INTO core."user" (id, email) VALUES ('us_b', 'dup@mague.pt') $$,
  '23505',
  NULL,
  'users_email_active_uq bloqueia 2.o utilizador ativo com o mesmo email'
);

-- ═══ Test 7: soft-delete liberta o email para re-registo ══════════════════════
UPDATE core."user" SET deleted_at = now() WHERE id = 'us_a';
SELECT lives_ok(
  $$ INSERT INTO core."user" (id, email) VALUES ('us_c', 'dup@mague.pt') $$,
  'apos soft-delete, novo utilizador ativo com o mesmo email e aceite'
);

SELECT * FROM finish();
ROLLBACK;
