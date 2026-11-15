-- 0048_attachment_polymorphic_and_bank_account_schema.sql
--
-- Cobre:
--
-- 1. Schema de finance.bank_account - assert que NÃO tem coluna `updated_at`
--    (uma query que referencie `ba.updated_at` dá erro 500 na página
--    /admin/c/:cid/bank-accounts).
--
-- 2. core.attachment polymorphic constraint:
--    - INSERT com entity_type fora do allow-list deve falhar.
--    - storage_key UNIQUE constraint deve rejeitar duplicados.
--    - Cobertura cross-entity (charge + ticket + assembly), em complemento
--      ao 0040, que só cobre inspection.
--
-- 3. bank_account.opening_split CHECK constraint (opening_balance =
--    ordinary + fcr) deve rejeitar splits inconsistentes.

BEGIN;
SELECT plan(14);

-- ═══ Setup ═══════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_pgt', 'Polym Test');

-- Para test 4 e 5: criar uma charge, ticket, assembly como "pais".
INSERT INTO finance.bank_account (id, condominium_id, bank_name)
  VALUES ('ba_pgt', 'cd_pgt', 'Test Bank');
INSERT INTO finance.charge (id, condominium_id, kind, nature, charge_type, status,
       scope, issue_date, due_date, competence_period,
       original_amount, expected_amount, open_amount, description)
  VALUES ('ch_pgt', 'cd_pgt', 'payable', 'debit', 'expense', 'open',
          'unit', CURRENT_DATE, NULL, '2026-05-01',
          1000, 1000, 1000, 'X');
INSERT INTO core.ticket (id, condominium_id, title, category, created_by)
  VALUES ('tk_pgt', 'cd_pgt', 'X', 'elevator', '{"id":"u"}'::jsonb);
INSERT INTO core.assembly (id, condominium_id, type, scheduled_at)
  VALUES ('as_pgt', 'cd_pgt', 'ordinary', '2026-12-01T19:00+00:00');

-- ═══ Test 1: bank_account NÃO tem coluna updated_at ═════════════════════════
-- Regressão: a query em list_with_stats.ts referenciava `ba.updated_at`
-- mas a coluna nunca existiu no schema. O ideal é tê-la, mas até alguém
-- adicionar uma migration para a criar, asseguramos que o código não
-- assume que ela existe.
SELECT is(
  (SELECT count(*)::int FROM information_schema.columns
     WHERE table_schema='finance' AND table_name='bank_account' AND column_name='updated_at'),
  0,
  'finance.bank_account: coluna updated_at NÃO existe (regression guard)'
);

-- ═══ Test 2: bank_account tem as colunas mínimas esperadas ═══════════════════
SELECT is(
  (SELECT count(*)::int FROM information_schema.columns
     WHERE table_schema='finance' AND table_name='bank_account'
       AND column_name IN ('id','condominium_id','bank_name','iban','account_name',
                            'is_active','created_at','deleted_at','opening_balance',
                            'opening_balance_date','kind','is_quota_payment')),
  12,
  'finance.bank_account: tem todas as 12 colunas esperadas'
);

-- ═══ Test 3: bank_account opening_split CHECK rejeita inconsistente ═════════
-- opening_balance = ordinary + fcr OU todos = 0.
SELECT throws_ok(
  $$ INSERT INTO finance.bank_account
       (id, condominium_id, bank_name, opening_balance,
        opening_balance_ordinary_cents, opening_balance_fcr_cents)
     VALUES ('ba_bad','cd_pgt','X', 1000, 800, 100) $$,
  '23514',
  NULL,
  'CHECK opening_split: 1000 != 800+100 → rejeita'
);

-- Caso bom: 1000 = 600 + 400
SELECT lives_ok(
  $$ INSERT INTO finance.bank_account
       (id, condominium_id, bank_name, opening_balance,
        opening_balance_ordinary_cents, opening_balance_fcr_cents)
     VALUES ('ba_ok','cd_pgt','X', 1000, 600, 400) $$,
  'CHECK opening_split: 1000 = 600+400 → aceita'
);

-- ═══ Test 4: attachment polymorphic constraint rejeita entity_type fora ═════
SELECT throws_ok(
  $$ INSERT INTO core.attachment
       (id, condominium_id, entity_type, entity_id, filename, mime_type,
        storage_key, file_size, created_by)
     VALUES ('att_bad', 'cd_pgt', 'invalid_entity', 'x', 'f.pdf', 'application/pdf',
             'cd_pgt/x/x/x/x/att_bad-f.pdf', 100, '{"id":"u"}'::jsonb) $$,
  '23514',
  NULL,
  'CHECK entity_type: rejeita valores fora do allow-list (charge|ticket|inspection|assembly|insurance)'
);

-- ═══ Test 5: attachment para CHARGE (cross-entity coverage) ═════════════════
INSERT INTO core.attachment (id, condominium_id, entity_type, entity_id, filename, mime_type, storage_key, file_size, created_by)
VALUES ('att_ch', 'cd_pgt', 'charge', 'ch_pgt', 'factura.pdf', 'application/pdf',
        'cd_pgt/charge/c/h/ch_pgt/att_ch-factura.pdf', 12000, '{"id":"u"}'::jsonb);

SELECT is(
  (SELECT entity_type FROM core.attachment WHERE id='att_ch'),
  'charge',
  'INSERT attachment com entity_type=charge persiste'
);

-- ═══ Test 6: attachment para TICKET ═════════════════════════════════════════
INSERT INTO core.attachment (id, condominium_id, entity_type, entity_id, filename, mime_type, storage_key, file_size, created_by)
VALUES ('att_tk', 'cd_pgt', 'ticket', 'tk_pgt', 'foto.jpg', 'image/jpeg',
        'cd_pgt/ticket/t/k/tk_pgt/att_tk-foto.jpg', 8000, '{"id":"u"}'::jsonb);

SELECT is(
  (SELECT entity_type FROM core.attachment WHERE id='att_tk'),
  'ticket',
  'INSERT attachment com entity_type=ticket persiste'
);

-- ═══ Test 7: attachment para ASSEMBLY ═══════════════════════════════════════
INSERT INTO core.attachment (id, condominium_id, entity_type, entity_id, filename, mime_type, storage_key, file_size, created_by)
VALUES ('att_as', 'cd_pgt', 'assembly', 'as_pgt', 'acta.pdf', 'application/pdf',
        'cd_pgt/assembly/a/s/as_pgt/att_as-acta.pdf', 25000, '{"id":"u"}'::jsonb);

SELECT is(
  (SELECT entity_type FROM core.attachment WHERE id='att_as'),
  'assembly',
  'INSERT attachment com entity_type=assembly persiste'
);

-- ═══ Test 8: storage_key UNIQUE rejeita duplicado ═══════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.attachment
       (id, condominium_id, entity_type, entity_id, filename, mime_type,
        storage_key, file_size, created_by)
     VALUES ('att_dup', 'cd_pgt', 'charge', 'ch_pgt', 'x.pdf', 'application/pdf',
             'cd_pgt/charge/c/h/ch_pgt/att_ch-factura.pdf', 100, '{"id":"u"}'::jsonb) $$,
  '23505',
  NULL,
  'storage_key UNIQUE: rejeita 2 anexos com a mesma key (anti-collision em S3)'
);

-- ═══ Test 9: cross-entity query funciona - count por entity_type ════════════
SELECT is(
  (SELECT count(*)::int FROM core.attachment
     WHERE condominium_id='cd_pgt' AND deleted_at IS NULL),
  3,  -- charge + ticket + assembly
  'cross-entity: 3 anexos persistidos (1 por entidade) no mesmo condo'
);

-- ═══ Test 10: filtro por entity_type isola entidades ════════════════════════
SELECT is(
  (SELECT count(*)::int FROM core.attachment
     WHERE entity_type='charge' AND condominium_id='cd_pgt' AND deleted_at IS NULL),
  1,
  'filtro entity_type=charge devolve só os da charge'
);

-- ═══ Test 11: soft-delete + filtro deleted_at IS NULL ═══════════════════════
UPDATE core.attachment SET deleted_at=now(), deleted_by='{"id":"u"}'::jsonb WHERE id='att_tk';
SELECT is(
  (SELECT count(*)::int FROM core.attachment
     WHERE condominium_id='cd_pgt' AND deleted_at IS NULL),
  2,  -- 3 - 1 soft-deleted
  'soft-delete: anexo eliminado deixa de aparecer (deleted_at IS NOT NULL)'
);

-- ═══ Test 12: audit captou INSERT em attachment de charge ═══════════════════
SELECT cmp_ok(
  (SELECT count(*)::int FROM audit.cdc_log
     WHERE table_schema='core' AND table_name='attachment' AND row_id='att_ch' AND action='insert'),
  '>=',
  1,
  'audit.cdc_log capturou INSERT do attachment do charge'
);

-- ═══ Test 13: required column NOT NULL ═════════════════════════════════════
-- file_size, filename, mime_type, storage_key são obrigatórios.
SELECT throws_ok(
  $$ INSERT INTO core.attachment
       (id, condominium_id, entity_type, entity_id, filename, mime_type,
        storage_key, created_by)
     VALUES ('att_nofs', 'cd_pgt', 'charge', 'ch_pgt', 'x.pdf', 'application/pdf',
             'cd_pgt/charge/x/y/z/att_nofs.pdf', '{"id":"u"}'::jsonb) $$,
  '23502',
  NULL,
  'NOT NULL file_size: INSERT sem file_size é rejeitado'
);

SELECT * FROM finish();
ROLLBACK;
