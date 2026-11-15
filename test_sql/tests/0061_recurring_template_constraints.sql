-- 0061_recurring_template_constraints.sql
--
-- Invariantes de schema do template recorrente (core.recurring_template). O
-- algoritmo de geracao vive em TS (ADR 0001) - aqui validamos apenas os CHECKs
-- de dominio que o schema garante:
--   • recurring_template_amount_check: amount > 0
--   • recurring_template_day_check: day_of_month NULL ou [1..28]
--   • recurring_template_interval_check: monthly|bimonthly|quarterly|semiannual|annual
--   • recurring_template_kind_check: receivable|payable
--   • recurring_template_payment_method_check: manual|direct_debit|auto_transfer
--
-- Nota: throws_ok apanha a excecao numa subtransacao interna, por isso nao
-- precisa de SAVEPOINT externo.

BEGIN;
SELECT plan(8);

INSERT INTO core.condominium (id, name) VALUES ('cd_rec', 'Recurring Test');

-- ═══ Test 1: template valido persiste ═════════════════════════════════════════
SELECT lives_ok(
  $$ INSERT INTO core.recurring_template (condominium_id, kind, description, amount,
       interval_type, start_date, next_run_date, day_of_month)
     VALUES ('cd_rec', 'receivable', 'Quota mensal', 5000, 'monthly',
       '2026-01-01', '2026-01-01', 1) $$,
  'template valido (amount>0, day=1, monthly) e aceite'
);

-- ═══ Test 2: amount <= 0 bloqueado ════════════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.recurring_template (condominium_id, kind, description, amount,
       interval_type, start_date, next_run_date)
     VALUES ('cd_rec', 'receivable', 'X', 0, 'monthly', '2026-01-01', '2026-01-01') $$,
  '23514',
  NULL,
  'recurring_template_amount_check rejeita amount 0'
);

-- ═══ Test 3: day_of_month = 0 bloqueado ═══════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.recurring_template (condominium_id, kind, description, amount,
       interval_type, start_date, next_run_date, day_of_month)
     VALUES ('cd_rec', 'receivable', 'X', 5000, 'monthly', '2026-01-01', '2026-01-01', 0) $$,
  '23514',
  NULL,
  'recurring_template_day_check rejeita dia 0'
);

-- ═══ Test 4: day_of_month = 29 bloqueado (limite 28 por seguranca de mes) ═════
SELECT throws_ok(
  $$ INSERT INTO core.recurring_template (condominium_id, kind, description, amount,
       interval_type, start_date, next_run_date, day_of_month)
     VALUES ('cd_rec', 'receivable', 'X', 5000, 'monthly', '2026-01-01', '2026-01-01', 29) $$,
  '23514',
  NULL,
  'recurring_template_day_check rejeita dia 29'
);

-- ═══ Test 5: day_of_month NULL aceite (sem dia fixo) ══════════════════════════
SELECT lives_ok(
  $$ INSERT INTO core.recurring_template (condominium_id, kind, description, amount,
       interval_type, start_date, next_run_date, day_of_month)
     VALUES ('cd_rec', 'payable', 'X', 5000, 'annual', '2026-01-01', '2026-01-01', NULL) $$,
  'day_of_month NULL e aceite'
);

-- ═══ Test 6: interval_type invalido bloqueado ════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.recurring_template (condominium_id, kind, description, amount,
       interval_type, start_date, next_run_date)
     VALUES ('cd_rec', 'receivable', 'X', 5000, 'weekly', '2026-01-01', '2026-01-01') $$,
  '23514',
  NULL,
  'recurring_template_interval_check rejeita "weekly"'
);

-- ═══ Test 7: kind invalido bloqueado ══════════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.recurring_template (condominium_id, kind, description, amount,
       interval_type, start_date, next_run_date)
     VALUES ('cd_rec', 'transfer', 'X', 5000, 'monthly', '2026-01-01', '2026-01-01') $$,
  '23514',
  NULL,
  'recurring_template_kind_check rejeita kind fora de receivable|payable'
);

-- ═══ Test 8: payment_method invalido bloqueado ═══════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.recurring_template (condominium_id, kind, description, amount,
       interval_type, start_date, next_run_date, payment_method)
     VALUES ('cd_rec', 'payable', 'X', 5000, 'monthly', '2026-01-01', '2026-01-01', 'crypto') $$,
  '23514',
  NULL,
  'recurring_template_payment_method_check rejeita "crypto"'
);

SELECT * FROM finish();
ROLLBACK;
