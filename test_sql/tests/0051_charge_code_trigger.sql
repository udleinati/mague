-- 0051_charge_code_trigger.sql
--
-- Trigger BEFORE INSERT `fn_charge_assign_code` (component 010):
-- atribui `code` humano por prefixo: `D` payable + 4 chars base-36,
-- `R` receivable + 5 chars, per (condo, prefix) via
-- `finance.charge_code_counter`. Idempotente: se code já passado, respeita.
--
-- Cobre:
--   1. Sequência D crescente em payable.
--   2. Sequência R crescente em receivable.
--   3. Sequências D e R independentes per condo.
--   4. Multi-condo isolado.
--   5. Idempotência: code passado explicitamente não é sobrescrito.
--   6. CHECK constraint do format rejeita strings inválidas.
--   7. fn_charge_code_format devolve valores correctos.

BEGIN;
SELECT plan(16);

-- ═══ Setup ════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_cc1', 'Code test 1'), ('cd_cc2', 'Code test 2');
INSERT INTO core.unit (id, condominium_id, designation, permillage)
  VALUES ('u_cc1a', 'cd_cc1', 'A', 500),
         ('u_cc1b', 'cd_cc1', 'B', 500),
         ('u_cc2a', 'cd_cc2', 'A', 1000);

-- ═══ Test 1+2: Sequência D em payable ════════════════════════════════════
INSERT INTO finance.charge (
  condominium_id, kind, nature, charge_type, status,
  issue_date, competence_period, original_amount, expected_amount, open_amount, amount,
  description, scope
) VALUES
  ('cd_cc1', 'payable', 'debit', 'expense', 'open', '2026-01-01', '2026-01-01',
   1000, 1000, 1000, 0, 'first payable', 'condominium'),
  ('cd_cc1', 'payable', 'debit', 'expense', 'open', '2026-02-01', '2026-02-01',
   2000, 2000, 2000, 0, 'second payable', 'condominium');

SELECT is(
  (SELECT code FROM finance.charge WHERE description='first payable' AND condominium_id='cd_cc1'),
  'D0001',
  'primeira charge payable do condo recebe D0001'
);

SELECT is(
  (SELECT code FROM finance.charge WHERE description='second payable' AND condominium_id='cd_cc1'),
  'D0002',
  'segunda charge payable do mesmo condo recebe D0002'
);

-- ═══ Test 3: Sequência R em receivable (independente da D) ═══════════════
INSERT INTO finance.charge (
  condominium_id, unit_id, kind, nature, charge_type, status,
  issue_date, competence_period, original_amount, expected_amount, open_amount, amount,
  description, scope
) VALUES
  ('cd_cc1', 'u_cc1a', 'receivable', 'debit', 'quota', 'open', '2026-01-01', '2026-01-01',
   100, 100, 100, 0, 'first receivable', 'unit');

SELECT is(
  (SELECT code FROM finance.charge WHERE description='first receivable'),
  'R00001',
  'primeira receivable arranca em R00001 (5 dígitos, sequência independente de D)'
);

-- ═══ Test 4: Multi-condo isolado ═════════════════════════════════════════
INSERT INTO finance.charge (
  condominium_id, kind, nature, charge_type, status,
  issue_date, competence_period, original_amount, expected_amount, open_amount, amount,
  description, scope
) VALUES
  ('cd_cc2', 'payable', 'debit', 'expense', 'open', '2026-01-01', '2026-01-01',
   500, 500, 500, 0, 'condo2 first', 'condominium');

SELECT is(
  (SELECT code FROM finance.charge WHERE condominium_id='cd_cc2' AND description='condo2 first'),
  'D0001',
  'condo2 arranca em D0001 (sequência per-condo, não global)'
);

-- ═══ Test 5: Counter table reflete last_number ═════════════════════════
SELECT is(
  (SELECT last_number FROM finance.charge_code_counter WHERE condominium_id='cd_cc1' AND prefix='D'),
  2,
  'counter cd_cc1/D = 2 após 2 payables'
);

SELECT is(
  (SELECT last_number FROM finance.charge_code_counter WHERE condominium_id='cd_cc1' AND prefix='R'),
  1,
  'counter cd_cc1/R = 1 após 1 receivable'
);

-- ═══ Test 6: Idempotência - code explícito respeitado ════════════════════
INSERT INTO finance.charge (
  condominium_id, code, kind, nature, charge_type, status,
  issue_date, competence_period, original_amount, expected_amount, open_amount, amount,
  description, scope
) VALUES
  ('cd_cc1', 'D9999', 'payable', 'debit', 'expense', 'open', '2026-03-01', '2026-03-01',
   1, 1, 1, 0, 'explicit code', 'condominium');

SELECT is(
  (SELECT code FROM finance.charge WHERE description='explicit code'),
  'D9999',
  'code explícito no INSERT é respeitado (trigger não sobrescreve)'
);

-- Counter não deveria ter sido tocado pelo code explícito (porque trigger
-- saiu cedo com RETURN NEW antes de fazer o UPSERT).
SELECT is(
  (SELECT last_number FROM finance.charge_code_counter WHERE condominium_id='cd_cc1' AND prefix='D'),
  2,
  'counter mantém 2 após INSERT com code explícito (não consumiu sequência)'
);

-- ═══ Test 7: CHECK format rejeita inválidos ══════════════════════════════
SAVEPOINT bad_format;
SELECT throws_ok(
  $$ INSERT INTO finance.charge (
       condominium_id, code, kind, nature, charge_type, status,
       issue_date, competence_period, original_amount, expected_amount, open_amount, amount,
       description, scope
     ) VALUES (
       'cd_cc1', 'X9999', 'payable', 'debit', 'expense', 'open', '2026-01-01', '2026-01-01',
       1, 1, 1, 0, 'bad prefix', 'condominium'
     ) $$,
  '23514',
  NULL,
  'CHECK constraint rejeita code com prefixo inválido (não D/R)'
);
ROLLBACK TO SAVEPOINT bad_format;

SAVEPOINT bad_format2;
SELECT throws_ok(
  $$ INSERT INTO finance.charge (
       condominium_id, code, kind, nature, charge_type, status,
       issue_date, competence_period, original_amount, expected_amount, open_amount, amount,
       description, scope
     ) VALUES (
       'cd_cc1', 'D001', 'payable', 'debit', 'expense', 'open', '2026-01-01', '2026-01-01',
       1, 1, 1, 0, 'too short', 'condominium'
     ) $$,
  '23514',
  NULL,
  'CHECK rejeita code com menos de 4 dígitos'
);
ROLLBACK TO SAVEPOINT bad_format2;

-- D com 5 dígitos é rejeitado (D é exatamente 4).
-- R com 5 dígitos continua válido (ver test 3).
SAVEPOINT bad_format3;
SELECT throws_ok(
  $$ INSERT INTO finance.charge (
       condominium_id, code, kind, nature, charge_type, status,
       issue_date, competence_period, original_amount, expected_amount, open_amount, amount,
       description, scope
     ) VALUES (
       'cd_cc1', 'D00001', 'payable', 'debit', 'expense', 'open', '2026-01-01', '2026-01-01',
       1, 1, 1, 0, 'D five digits', 'condominium'
     ) $$,
  '23514',
  NULL,
  'CHECK rejeita D com 5 dígitos (D é exatamente 4)'
);
ROLLBACK TO SAVEPOINT bad_format3;

-- R com 4 dígitos é rejeitado (R é exatamente 5).
SAVEPOINT bad_format4;
SELECT throws_ok(
  $$ INSERT INTO finance.charge (
       condominium_id, unit_id, code, kind, nature, charge_type, status,
       issue_date, competence_period, original_amount, expected_amount, open_amount, amount,
       description, scope
     ) VALUES (
       'cd_cc1', 'u_cc1a', 'R0001', 'receivable', 'debit', 'quota', 'open', '2026-01-01', '2026-01-01',
       1, 1, 1, 0, 'R four digits', 'unit'
     ) $$,
  '23514',
  NULL,
  'CHECK rejeita R com 4 dígitos (R é exatamente 5)'
);
ROLLBACK TO SAVEPOINT bad_format4;

-- ═══ Test 8+9: fn_charge_code_format devolve valores correctos ───────────
SELECT is(
  finance.fn_charge_code_format(1, 'D'),
  'D0001',
  'fn_charge_code_format(1, D) → D0001'
);

SELECT is(
  finance.fn_charge_code_format(21, 'D'),
  'D000L',
  'fn_charge_code_format(21, D) → D000L (4 dígitos; L=21 base-36)'
);

SELECT is(
  finance.fn_charge_code_format(60466175, 'R'),
  'RZZZZZ',
  'fn_charge_code_format(60466175, R) → RZZZZZ (36^5-1, R mantém 5 dígitos)'
);

SELECT is(
  finance.fn_charge_code_format(1679616, 'D'),
  NULL,
  'fn_charge_code_format(36^4, D) → NULL (acima da capacidade de 4 dígitos do D)'
);

SELECT * FROM finish();
ROLLBACK;
