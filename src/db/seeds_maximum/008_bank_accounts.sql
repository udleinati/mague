-- 008_bank_accounts.sql - 1 conta bancária por condomínio.
--
-- Conta `is_quota_payment=true` (recebe quotas dos condóminos). Saldo de
-- abertura zero - serão os settlements que vão construir o saldo a partir
-- das charges 2020-2026.

INSERT INTO finance.bank_account (
  id, condominium_id, bank_name, iban, account_name,
  opening_balance, opening_balance_date, is_quota_payment, kind, is_active
)
VALUES
  ('ba_max_1', 'condo_max_1', 'Caixa Geral de Depósitos',
   'PT50003500000000000000001', 'Conta corrente',
   0, '2019-12-31', true, 'bank', true),
  ('ba_max_2', 'condo_max_2', 'Banco Santander',
   'PT50003200000000000000002', 'Conta corrente',
   0, '2019-12-31', true, 'bank', true),
  ('ba_max_3', 'condo_max_3', 'Millennium BCP',
   'PT50003300000000000000003', 'Conta corrente',
   0, '2019-12-31', true, 'bank', true),
  ('ba_max_4', 'condo_max_4', 'Novo Banco',
   'PT50000700000000000000004', 'Conta corrente',
   0, '2019-12-31', true, 'bank', true),
  ('ba_max_5', 'condo_max_5', 'BPI',
   'PT50001000000000000000005', 'Conta corrente',
   0, '2019-12-31', true, 'bank', true)
ON CONFLICT (id) DO NOTHING;
