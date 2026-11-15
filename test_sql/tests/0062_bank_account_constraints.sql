-- 0062_bank_account_constraints.sql
--
-- Invariantes de schema da conta (finance.bank_account):
--   • bank_account_kind_check: kind in (bank, cash)
--   • bank_account_opening_split_matches: saldo de abertura = ordinario + FCR
--     (excecao: tudo a zero). Garante que o split FCR fecha (ver ADR 0001).
--   • bank_account_quota_only_for_bank: is_quota_payment so para kind=bank
--
-- Nota: throws_ok apanha a excecao numa subtransacao interna, por isso nao
-- precisa de SAVEPOINT externo.

BEGIN;
SELECT plan(6);

INSERT INTO core.condominium (id, name) VALUES ('cd_ba', 'BankAccount Test');

-- ═══ Test 1: kind invalido bloqueado ══════════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO finance.bank_account (condominium_id, bank_name, kind)
     VALUES ('cd_ba', 'Banco X', 'crypto') $$,
  '23514',
  NULL,
  'bank_account_kind_check rejeita kind fora de bank|cash'
);

-- ═══ Test 2: split de abertura inconsistente bloqueado ════════════════════════
SELECT throws_ok(
  $$ INSERT INTO finance.bank_account (condominium_id, bank_name,
       opening_balance, opening_balance_ordinary_cents, opening_balance_fcr_cents)
     VALUES ('cd_ba', 'Banco X', 1000, 600, 300) $$,
  '23514',
  NULL,
  'bank_account_opening_split_matches rejeita ordinario+FCR != opening_balance'
);

-- ═══ Test 3: split de abertura consistente aceite ═════════════════════════════
SELECT lives_ok(
  $$ INSERT INTO finance.bank_account (condominium_id, bank_name,
       opening_balance, opening_balance_ordinary_cents, opening_balance_fcr_cents)
     VALUES ('cd_ba', 'Banco Y', 1000, 600, 400) $$,
  'opening_balance = ordinario + FCR e aceite'
);

-- ═══ Test 4: tudo a zero aceite (excecao do CHECK) ════════════════════════════
SELECT lives_ok(
  $$ INSERT INTO finance.bank_account (condominium_id, bank_name)
     VALUES ('cd_ba', 'Banco Z') $$,
  'conta sem saldo de abertura (0/0/0) e aceite'
);

-- ═══ Test 5: is_quota_payment com kind=cash bloqueado ═════════════════════════
SELECT throws_ok(
  $$ INSERT INTO finance.bank_account (condominium_id, bank_name, kind, is_quota_payment)
     VALUES ('cd_ba', 'Caixa', 'cash', true) $$,
  '23514',
  NULL,
  'bank_account_quota_only_for_bank rejeita is_quota_payment em conta cash'
);

-- ═══ Test 6: is_quota_payment com kind=bank aceite ════════════════════════════
SELECT lives_ok(
  $$ INSERT INTO finance.bank_account (condominium_id, bank_name, kind, is_quota_payment)
     VALUES ('cd_ba', 'Banco Quota', 'bank', true) $$,
  'is_quota_payment numa conta bank e aceite'
);

SELECT * FROM finish();
ROLLBACK;
