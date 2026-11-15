-- 0064_fcr_transfer.sql
--
-- Transferência entre a bolsa ordinária (121) e a bolsa FCR (122).
-- Ver `finance.fcr_transfer` e docs/flows/05-fluxo-fcr.md (DF4).
--
-- Cobre:
--   • CHECKs de schema (direction no enum, amount_cents > 0)
--   • O efeito que a feature promete: v_bank_balance move entre bolsas e o
--     total do condomínio NÃO muda (o dinheiro não sai do banco)
--   • Append-only: UPDATE/DELETE no ledger emitido continuam bloqueados
--
-- Nota: throws_ok apanha a excecao numa subtransacao interna, por isso nao
-- precisa de SAVEPOINT externo.

BEGIN;
SELECT plan(9);

INSERT INTO core.condominium (id, name) VALUES ('cd_fcrt', 'FCR Transfer Test');

-- Bolsas iniciais via saldo de abertura no ledger: 300,00 ord + 100,00 FCR.
-- (Replica o que o handler set_opening_balance faz: Dr banco / Cr equity.)
INSERT INTO finance.ledger
  (condominium_id, entity_type, entry_date, entry_type, account_code, direction, amount, description)
VALUES
  ('cd_fcrt', 'condominium', '2026-01-01', 'openingBalance', '121', 'debit',  30000, 'Saldo inicial ordinário'),
  ('cd_fcrt', 'condominium', '2026-01-01', 'openingBalance', '59',  'credit', 30000, 'Saldo inicial ordinário'),
  ('cd_fcrt', 'condominium', '2026-01-01', 'openingBalance', '122', 'debit',  10000, 'Saldo inicial FCR'),
  ('cd_fcrt', 'condominium', '2026-01-01', 'openingBalance', '581', 'credit', 10000, 'Saldo inicial FCR');

-- ═══ Test 1: direction fora do enum bloqueada ════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO finance.fcr_transfer (condominium_id, direction, amount_cents, transfer_date, reason)
     VALUES ('cd_fcrt', 'to_bank', 5000, '2026-03-01', 'x') $$,
  '23514',
  NULL,
  'fcr_transfer_direction_check rejeita direction fora de to_fcr|to_ordinary'
);

-- ═══ Test 2: montante zero bloqueado ═════════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO finance.fcr_transfer (condominium_id, direction, amount_cents, transfer_date, reason)
     VALUES ('cd_fcrt', 'to_fcr', 0, '2026-03-01', 'x') $$,
  '23514',
  NULL,
  'fcr_transfer_amount_check rejeita montante zero'
);

-- ═══ Test 3: montante negativo bloqueado ═════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO finance.fcr_transfer (condominium_id, direction, amount_cents, transfer_date, reason)
     VALUES ('cd_fcrt', 'to_fcr', -5000, '2026-03-01', 'x') $$,
  '23514',
  NULL,
  'fcr_transfer_amount_check rejeita montante negativo'
);

-- ═══ Test 4: motivo é obrigatório ════════════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO finance.fcr_transfer (condominium_id, direction, amount_cents, transfer_date, reason)
     VALUES ('cd_fcrt', 'to_fcr', 5000, '2026-03-01', NULL) $$,
  '23502',
  NULL,
  'reason NOT NULL - transferência sem justificação não é auditável'
);

-- ═══ Setup: reforço de 50,00 (ordinária → FCR), como o handler TS o emite ════
INSERT INTO finance.fcr_transfer (id, condominium_id, direction, amount_cents, transfer_date, reason)
VALUES ('fcrt_1', 'cd_fcrt', 'to_fcr', 5000, '2026-03-01', 'Deliberação da assembleia de 2026-02-15');

INSERT INTO finance.ledger
  (condominium_id, entity_type, entry_date, entry_type, account_code, direction, amount, description, ref_type, ref_id)
VALUES
  ('cd_fcrt', 'condominium', '2026-03-01', 'fcrTransfer', '122', 'debit',  5000, 'Transferência para bolsa FCR', 'fcr_transfer', 'fcrt_1'),
  ('cd_fcrt', 'condominium', '2026-03-01', 'fcrTransfer', '121', 'credit', 5000, 'Transferência para bolsa FCR', 'fcr_transfer', 'fcrt_1');

-- ═══ Test 5-7: as bolsas moveram-se, o total não ═════════════════════════════
SELECT is(
  (SELECT ordinary_cents FROM finance.v_bank_balance WHERE condominium_id = 'cd_fcrt'),
  25000,
  'reforço tira da bolsa ordinária (300,00 - 50,00)'
);

SELECT is(
  (SELECT fcr_cents FROM finance.v_bank_balance WHERE condominium_id = 'cd_fcrt'),
  15000,
  'reforço põe na bolsa FCR (100,00 + 50,00)'
);

-- A invariante da feature: é reclassificação, não movimento bancário.
SELECT is(
  (SELECT total_cents FROM finance.v_bank_balance WHERE condominium_id = 'cd_fcrt'),
  40000,
  'total do condomínio inalterado - nenhum euro saiu do banco'
);

-- ═══ Test 8: levantamento inverte, e é assim que se corrige um engano ════════
INSERT INTO finance.fcr_transfer (id, condominium_id, direction, amount_cents, transfer_date, reason)
VALUES ('fcrt_2', 'cd_fcrt', 'to_ordinary', 5000, '2026-04-01', 'Correção da transferência fcrt_1');

INSERT INTO finance.ledger
  (condominium_id, entity_type, entry_date, entry_type, account_code, direction, amount, description, ref_type, ref_id)
VALUES
  ('cd_fcrt', 'condominium', '2026-04-01', 'fcrTransfer', '121', 'debit',  5000, 'Transferência da bolsa FCR para ordinária', 'fcr_transfer', 'fcrt_2'),
  ('cd_fcrt', 'condominium', '2026-04-01', 'fcrTransfer', '122', 'credit', 5000, 'Transferência da bolsa FCR para ordinária', 'fcr_transfer', 'fcrt_2');

SELECT results_eq(
  $$ SELECT ordinary_cents, fcr_cents, total_cents
       FROM finance.v_bank_balance WHERE condominium_id = 'cd_fcrt' $$,
  $$ VALUES (30000, 10000, 40000) $$,
  'transferência inversa repõe as bolsas - é o mecanismo de anulação (não há delete)'
);

-- ═══ Test 9: o ledger emitido continua imutável (component 014) ══════════════
SELECT throws_ok(
  $$ DELETE FROM finance.ledger WHERE ref_type = 'fcr_transfer' $$,
  '42501',
  NULL,
  'ledger da transferência é append-only - corrigir é lançar a inversa'
);

SELECT * FROM finish();
ROLLBACK;
