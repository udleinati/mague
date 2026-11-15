-- 0058_receipt_constraints.sql
--
-- Invariantes fiscais do recibo (finance.receipt). A numeracao sequencial por
-- (condominio, ano) e requisito legal PT, por isso o schema tem de a garantir
-- a nivel de constraint - nao confiar so na app:
--   • receipt_seq_unique: 2 recibos com a mesma (condo, ano, sequence) bloqueado
--   • receipt_storage_unique: 1 storage_key por recibo (sem PDFs partilhados)
--   • receipt_void_consistency: anulacao e tudo-ou-nada (at + by + reason)
--   • receipt_amount_cents_check / receipt_sequence_check: > 0
--   • receipt_year_check: ano em [2000..2100]
--
-- Nota: throws_ok apanha a excecao numa subtransacao interna, por isso nao
-- precisa de SAVEPOINT externo.

BEGIN;
SELECT plan(10);

-- ═══ Setup: cadeia de FKs condominio → unidade → conta → movimento ════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_rcpt', 'Receipt Test');
INSERT INTO core.unit (id, condominium_id, designation, permillage)
  VALUES ('un_rcpt', 'cd_rcpt', 'Fr A', 100);
INSERT INTO finance.bank_account (id, condominium_id, bank_name)
  VALUES ('ba_rcpt', 'cd_rcpt', 'Banco Teste');
INSERT INTO finance.bank_transaction (id, bank_account_id, condominium_id, transaction_date, amount)
  VALUES ('bt_rcpt', 'ba_rcpt', 'cd_rcpt', '2026-01-15', 5000);

-- ═══ Test 1: recibo valido (seq=1) persiste ══════════════════════════════════
INSERT INTO finance.receipt (id, condominium_id, unit_id, bank_transaction_id, year,
  sequence, amount_cents, issued_by, condominium_snapshot, unit_snapshot,
  recipients_snapshot, lines_snapshot, bank_tx_snapshot, storage_key)
VALUES ('rc_1', 'cd_rcpt', 'un_rcpt', 'bt_rcpt', 2026, 1, 5000,
  '{"id":"u"}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
  'receipts/cd_rcpt/2026/1.pdf');

SELECT is(
  (SELECT sequence FROM finance.receipt WHERE id='rc_1'),
  1,
  'recibo base persistido com sequence=1'
);

-- ═══ Test 2: (condo, ano, sequence) duplicado bloqueado ═══════════════════════
SELECT throws_ok(
  $$ INSERT INTO finance.receipt (condominium_id, unit_id, bank_transaction_id, year,
       sequence, amount_cents, issued_by, condominium_snapshot, unit_snapshot,
       recipients_snapshot, lines_snapshot, bank_tx_snapshot, storage_key)
     VALUES ('cd_rcpt','un_rcpt','bt_rcpt',2026,1,5000,'{"id":"u"}'::jsonb,'{}'::jsonb,
       '{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb,'receipts/cd_rcpt/2026/dup.pdf') $$,
  '23505',
  NULL,
  'receipt_seq_unique bloqueia 2.o recibo com mesma (condo, ano, sequence)'
);

-- ═══ Test 3: sequence diferente no mesmo ano e aceite ═════════════════════════
SELECT lives_ok(
  $$ INSERT INTO finance.receipt (condominium_id, unit_id, bank_transaction_id, year,
       sequence, amount_cents, issued_by, condominium_snapshot, unit_snapshot,
       recipients_snapshot, lines_snapshot, bank_tx_snapshot, storage_key)
     VALUES ('cd_rcpt','un_rcpt','bt_rcpt',2026,2,5000,'{"id":"u"}'::jsonb,'{}'::jsonb,
       '{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb,'receipts/cd_rcpt/2026/2.pdf') $$,
  'sequence seguinte (2) no mesmo ano e aceite'
);

-- ═══ Test 4: storage_key duplicado bloqueado ══════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO finance.receipt (condominium_id, unit_id, bank_transaction_id, year,
       sequence, amount_cents, issued_by, condominium_snapshot, unit_snapshot,
       recipients_snapshot, lines_snapshot, bank_tx_snapshot, storage_key)
     VALUES ('cd_rcpt','un_rcpt','bt_rcpt',2026,3,5000,'{"id":"u"}'::jsonb,'{}'::jsonb,
       '{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb,'receipts/cd_rcpt/2026/1.pdf') $$,
  '23505',
  NULL,
  'receipt_storage_unique bloqueia storage_key repetido'
);

-- ═══ Test 5: amount_cents <= 0 bloqueado ══════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO finance.receipt (condominium_id, unit_id, bank_transaction_id, year,
       sequence, amount_cents, issued_by, condominium_snapshot, unit_snapshot,
       recipients_snapshot, lines_snapshot, bank_tx_snapshot, storage_key)
     VALUES ('cd_rcpt','un_rcpt','bt_rcpt',2026,9,0,'{"id":"u"}'::jsonb,'{}'::jsonb,
       '{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb,'receipts/cd_rcpt/2026/9.pdf') $$,
  '23514',
  NULL,
  'receipt_amount_cents_check rejeita montante 0'
);

-- ═══ Test 6: sequence <= 0 bloqueado ══════════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO finance.receipt (condominium_id, unit_id, bank_transaction_id, year,
       sequence, amount_cents, issued_by, condominium_snapshot, unit_snapshot,
       recipients_snapshot, lines_snapshot, bank_tx_snapshot, storage_key)
     VALUES ('cd_rcpt','un_rcpt','bt_rcpt',2026,0,5000,'{"id":"u"}'::jsonb,'{}'::jsonb,
       '{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb,'receipts/cd_rcpt/2026/z.pdf') $$,
  '23514',
  NULL,
  'receipt_sequence_check rejeita sequence 0'
);

-- ═══ Test 7: ano < 2000 bloqueado ═════════════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO finance.receipt (condominium_id, unit_id, bank_transaction_id, year,
       sequence, amount_cents, issued_by, condominium_snapshot, unit_snapshot,
       recipients_snapshot, lines_snapshot, bank_tx_snapshot, storage_key)
     VALUES ('cd_rcpt','un_rcpt','bt_rcpt',1999,4,5000,'{"id":"u"}'::jsonb,'{}'::jsonb,
       '{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb,'receipts/cd_rcpt/1999/4.pdf') $$,
  '23514',
  NULL,
  'receipt_year_check rejeita ano 1999'
);

-- ═══ Test 8: ano > 2100 bloqueado ═════════════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO finance.receipt (condominium_id, unit_id, bank_transaction_id, year,
       sequence, amount_cents, issued_by, condominium_snapshot, unit_snapshot,
       recipients_snapshot, lines_snapshot, bank_tx_snapshot, storage_key)
     VALUES ('cd_rcpt','un_rcpt','bt_rcpt',2101,5,5000,'{"id":"u"}'::jsonb,'{}'::jsonb,
       '{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb,'receipts/cd_rcpt/2101/5.pdf') $$,
  '23514',
  NULL,
  'receipt_year_check rejeita ano 2101'
);

-- ═══ Test 9: anulacao parcial (so voided_at) bloqueada ════════════════════════
SELECT throws_ok(
  $$ UPDATE finance.receipt SET voided_at = now() WHERE id='rc_1' $$,
  '23514',
  NULL,
  'receipt_void_consistency rejeita voided_at sem reason/by'
);

-- ═══ Test 10: anulacao completa (at + by + reason) aceite ═════════════════════
SELECT lives_ok(
  $$ UPDATE finance.receipt
       SET voided_at = now(), voided_by = '{"id":"u"}'::jsonb, voided_reason = 'erro de emissao'
     WHERE id='rc_1' $$,
  'receipt_void_consistency aceita anulacao com at + by + reason'
);

SELECT * FROM finish();
ROLLBACK;
