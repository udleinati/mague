-- 0029_login_tracking_and_receipt_access.sql
--
-- Valida 3 invariantes de login tracking e acesso a recibos:
--   1. Colunas de login tracking adicionadas a core.occupant + valores
--      default OK.
--   2. Counter `failed_login_attempts` em core.user é cumulativo (CHECK
--      >= 0; default 0; nunca volta a zero por acidente).
--   3. `recipients_access` em finance.receipt suporta operações JSONB
--      idempotentes (append-if-not-exists pattern).
--
-- Não cobre rate limit (Valkey) - fora do escopo SQL.

BEGIN;
SELECT plan(12);

-- ═══ Setup ═══════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name)
  VALUES ('cd_lt', 'Login tracking test condo');
INSERT INTO core.unit (id, condominium_id, designation, permillage, is_active)
  VALUES ('u_lt', 'cd_lt', 'A', 1000, true);
-- role é 'super' | NULL (ADR 0002) - occupant é inferido
-- de core.unit_occupant.relationship_type, não desta coluna.
INSERT INTO core.user (id, name, email, role, is_active, password_hash)
  VALUES ('usr_lt', 'Login Test User', 'lt@test.pt', NULL, true, 'fakehash');
INSERT INTO core.occupant (id, name, condominium_id, user_id)
  VALUES ('occ_lt', 'Login Test', 'cd_lt', 'usr_lt');
INSERT INTO finance.bank_account (id, condominium_id, bank_name, kind, is_active)
  VALUES ('ba_lt', 'cd_lt', 'Test Bank', 'bank', true);

-- ═══ Test 1: defaults dos novos campos do occupant ════════════════════
SELECT is(
  (SELECT first_login_at FROM core.occupant WHERE id = 'occ_lt'),
  NULL,
  'occupant.first_login_at default NULL'
);
SELECT is(
  (SELECT last_login_at FROM core.occupant WHERE id = 'occ_lt'),
  NULL,
  'occupant.last_login_at default NULL'
);

-- ═══ Test 2: defaults dos novos campos do user ════════════════════════
SELECT is(
  (SELECT failed_login_attempts FROM core.user WHERE id = 'usr_lt'),
  0,
  'user.failed_login_attempts default 0'
);
SELECT is(
  (SELECT password_changed_at FROM core.user WHERE id = 'usr_lt'),
  NULL,
  'user.password_changed_at default NULL'
);

-- ═══ Test 3: failed_login_attempts >= 0 (constraint CHECK) ════════════
SAVEPOINT neg_attempts;
SELECT throws_ok(
  $$ UPDATE core.user SET failed_login_attempts = -1 WHERE id = 'usr_lt' $$,
  '23514',
  NULL,
  'CHECK failed_login_attempts >= 0 bloqueia valor negativo'
);
ROLLBACK TO SAVEPOINT neg_attempts;

-- ═══ Test 4: simular login OK - first é write-once via COALESCE ═══════
-- Nota: NOW()/transaction_timestamp() são estáveis dentro da TX (sempre
-- mesmo valor durante o BEGIN). Para garantir que first ≠ last entre
-- updates sequenciais, usar clock_timestamp() (wall time real).
UPDATE core.occupant
   SET first_login_at = COALESCE(first_login_at, clock_timestamp()),
       last_login_at = clock_timestamp(),
       last_login_ip = '192.0.2.1'::inet,
       last_login_user_agent = 'Mozilla/5.0 Test'
 WHERE user_id = 'usr_lt';

SELECT isnt(
  (SELECT first_login_at FROM core.occupant WHERE id = 'occ_lt'),
  NULL,
  'first_login_at populado no 1º login'
);

-- Capturar valor do first_login_at após 1º login para comparar depois
CREATE TEMP TABLE _login_snap AS
SELECT first_login_at AS first_after_login1
  FROM core.occupant WHERE id = 'occ_lt';

-- ═══ Test 5: 2º login NÃO sobrescreve first_login_at ══════════════════
SELECT pg_sleep(0.05);  -- garante clock_timestamp() distinto
UPDATE core.occupant
   SET first_login_at = COALESCE(first_login_at, clock_timestamp()),  -- COALESCE preserva
       last_login_at = clock_timestamp(),
       last_login_ip = '198.51.100.1'::inet
 WHERE user_id = 'usr_lt';

-- first_login_at deve ser EXACTAMENTE igual ao snapshot do 1º login
SELECT is(
  (SELECT first_login_at FROM core.occupant WHERE id = 'occ_lt'),
  (SELECT first_after_login1 FROM _login_snap),
  '2º login: first_login_at preservado (write-once via COALESCE)'
);

-- ═══ Test 6: receipt criado tem recipients_access vazio ═══════════════
INSERT INTO finance.charge (
  id, condominium_id, kind, nature, charge_type, status,
  scope, unit_id, issue_date, competence_period,
  original_amount, expected_amount, open_amount, description
) VALUES (
  'ch_lt', 'cd_lt', 'receivable', 'debit', 'quota', 'open',
  'unit', 'u_lt', '2099-01-01', '2099-01-01',
  5000, 5000, 5000, 'Quota Janeiro/2099'
);
INSERT INTO finance.bank_transaction (
  id, condominium_id, bank_account_id, transaction_date,
  amount, description, status
) VALUES (
  'bt_lt', 'cd_lt', 'ba_lt', '2099-01-15',
  5000, 'Pagamento Quota', 'reconciled'
);
INSERT INTO finance.settlement (
  id, condominium_id, settlement_type, bank_transaction_id,
  debit_charge_id, amount, settlement_date, status
) VALUES (
  's_lt', 'cd_lt', 'bank_reconciliation', 'bt_lt',
  'ch_lt', 5000, '2099-01-15', 'active'
);
INSERT INTO finance.receipt (
  id, condominium_id, unit_id, bank_transaction_id,
  year, sequence, amount_cents, issued_by,
  condominium_snapshot, unit_snapshot, recipients_snapshot,
  lines_snapshot, bank_tx_snapshot, storage_key
) VALUES (
  'r_lt', 'cd_lt', 'u_lt', 'bt_lt',
  2099, 1, 5000,
  '{"id":"u_test","name":"Test"}'::jsonb,
  '{}'::jsonb, '{"designation":"A"}'::jsonb,
  '[{"occupantId":"occ_lt","name":"Login Test","nif":"123"}]'::jsonb,
  '[]'::jsonb, '{}'::jsonb, 'receipts/cd_lt/2099/2099-0001.pdf'
);

SELECT is(
  (SELECT recipients_access FROM finance.receipt WHERE id = 'r_lt'),
  '[]'::jsonb,
  'receipt.recipients_access default []'
);

-- ═══ Test 7: append idempotente - 1º append cria entry ═══════════════
UPDATE finance.receipt
   SET recipients_access = recipients_access ||
       jsonb_build_object('occupantId', 'occ_lt',
                          'firstDownloadedAt', '2099-02-01T10:00:00Z',
                          'occupantName', 'Login Test')
 WHERE id = 'r_lt'
   AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(recipients_access) AS a
      WHERE a->>'occupantId' = 'occ_lt'
   );

SELECT is(
  (SELECT jsonb_array_length(recipients_access) FROM finance.receipt WHERE id = 'r_lt'),
  1,
  'append: 1ª vez cria 1 entry'
);

-- ═══ Test 8: append idempotente - 2ª chamada com mesmo occupant é no-op ══
UPDATE finance.receipt
   SET recipients_access = recipients_access ||
       jsonb_build_object('occupantId', 'occ_lt',
                          'firstDownloadedAt', '2099-03-15T14:30:00Z',
                          'occupantName', 'Login Test 2')
 WHERE id = 'r_lt'
   AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(recipients_access) AS a
      WHERE a->>'occupantId' = 'occ_lt'
   );

SELECT is(
  (SELECT jsonb_array_length(recipients_access) FROM finance.receipt WHERE id = 'r_lt'),
  1,
  'append idempotente: 2ª chamada com mesmo occupantId NÃO cria nova entry'
);

-- ═══ Test 9: timestamp do 1º append preservado (write-once) ═══════════
SELECT is(
  (SELECT recipients_access->0->>'firstDownloadedAt' FROM finance.receipt WHERE id = 'r_lt'),
  '2099-02-01T10:00:00Z',
  'firstDownloadedAt do 1º append preservado (write-once por occupant)'
);

-- ═══ Test 10: append de DIFERENTE occupant adiciona nova entry ═══════
INSERT INTO core.occupant (id, name, condominium_id)
  VALUES ('occ_lt2', 'Outro Owner', 'cd_lt');
UPDATE finance.receipt
   SET recipients_access = recipients_access ||
       jsonb_build_object('occupantId', 'occ_lt2',
                          'firstDownloadedAt', '2099-04-10T09:00:00Z',
                          'occupantName', 'Outro Owner')
 WHERE id = 'r_lt'
   AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(recipients_access) AS a
      WHERE a->>'occupantId' = 'occ_lt2'
   );

SELECT is(
  (SELECT jsonb_array_length(recipients_access) FROM finance.receipt WHERE id = 'r_lt'),
  2,
  'append novo occupant: cria 2ª entry independente'
);

SELECT * FROM finish();
ROLLBACK;
