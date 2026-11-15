-- ═════════════════════════════════════════════════════════════════════════════
-- Pentest pgTAP: race condition em PATCH /charges/:id.
--
-- Cenário a evitar:
--   1. Handler faz SELECT (sem lock) → lê settled_amount=0, status='open'
--   2. JS guards passam.
--   3. Settlement concorrente modifica a charge → settled=100, open=400.
--   4. Um UPDATE sem repetir os guards no WHERE sobrescreveria
--      original_amount/expected/open mas deixaria settled=100 → invariante
--      `expected = open + settled` quebrado → corrupção financeira silenciosa.
--
-- Proteção: UPDATE com guards no WHERE (optimistic concurrency). Se o estado
-- mudou, 0 linhas afetadas, handler devolve 409.
--
-- Este teste valida o contrato SQL: UPDATE com `WHERE settled_amount = 0`
-- não afeta uma row em que settled mudou para > 0 entretanto.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(3);

-- ─── Setup: charge fictícia com original=500, todo open ────────────────────
-- Self-contained: cria o seu próprio condomínio em vez de depender de bleed
-- de outros tests.
INSERT INTO core.condominium (id, name, city)
VALUES ('c_race_test', 'Race Test Condo', 'Lisboa')
ON CONFLICT (id) DO NOTHING;

INSERT INTO finance.charge (
  id, condominium_id, kind, nature, charge_type,
  description, issue_date, due_date, competence_period,
  original_amount, expected_amount, open_amount, amount, status
)
VALUES (
  '_race_test_charge', 'c_race_test', 'payable', 'debit', 'invoice',
  'Race test', CURRENT_DATE, CURRENT_DATE, date_trunc('month', CURRENT_DATE)::date,
  500, 500, 500, 0, 'open'
);

-- ─── Simula settlement concorrente: charge passa a settled=100 ────────────
-- (Bypassamos o trigger fn_settlement_ai e UPDATE-amos diretamente para
-- evitar dependências de bank_account/bank_transaction. O efeito observável
-- na charge é o mesmo.)
UPDATE finance.charge SET
  settled_amount = 100,
  open_amount    = 400,
  status         = 'partial'
WHERE id = '_race_test_charge';

-- ─── REGRESSION: UPDATE com WHERE guards NÃO afeta charge mid-race ────────
-- Esta é a forma do UPDATE da API - repete settled_amount=0 no WHERE.
WITH attempted AS (
  UPDATE finance.charge SET
    original_amount = 300,
    expected_amount = 300,
    open_amount     = 300,
    amount          = 0,
    updated_at      = NOW()
  WHERE id = '_race_test_charge'
    AND status IN ('open', 'overdue')
    AND settled_amount = 0
  RETURNING 1
)
SELECT is(
  (SELECT count(*)::int FROM attempted),
  0,
  'UPDATE com WHERE settled_amount=0 não afeta charge cuja settled mudou para > 0 entretanto'
);

-- ─── Charge mantém estado pós-settlement (invariante intacto) ─────────────
SELECT is(
  (SELECT (expected_amount = open_amount + settled_amount)
     FROM finance.charge WHERE id = '_race_test_charge'),
  TRUE,
  'Invariante expected = open + settled mantém-se após race window protegida'
);

-- ─── Forma BUGGY (sem WHERE guards) afeta a row e quebra invariante ──────
-- Contraprova: um UPDATE sem os guards sobrescreve mesmo com settled > 0,
-- partindo o invariante.
UPDATE finance.charge SET
  original_amount = 300,
  expected_amount = 300,
  open_amount     = 300,
  amount          = 0
WHERE id = '_race_test_charge'; -- SEM os guards adicionais - replica o bug

SELECT isnt(
  (SELECT (expected_amount = open_amount + settled_amount)
     FROM finance.charge WHERE id = '_race_test_charge'),
  TRUE,
  'BUG REPRO: UPDATE sem guards quebra invariante (settled=100, mas expected=300, open=300 → 300 ≠ 400)'
);

SELECT * FROM finish();
ROLLBACK;
