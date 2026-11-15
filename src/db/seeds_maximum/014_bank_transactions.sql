-- 014_bank_transactions.sql - movimentos bancários por (condo × ano).
--
-- Volume: ~24 movimentos por ano por condomínio (~2/mês) × 5 × 7 = 840.
-- Mistura entradas (depósitos de quotas) e saídas (pagamentos a fornecedores).
-- Status: maioritariamente `unreconciled` para o admin ter trabalho na
-- fila de conciliação. Alguns como `reconciled` para haver histórico.
--
-- IDs: prefixo `bt_max_<condo_idx>_<yr>_<seq>`.

DO $$
DECLARE
  c_idx int;
  yr int;
  m int;
  bt_seq int := 1;
BEGIN
  FOR c_idx IN 1..5 LOOP
    FOR yr IN 2020..2026 LOOP
      FOR m IN 1..12 LOOP
        -- Movimento 1: depósito (entrada de quotas) ~10% das quotas mensais.
        bt_seq := bt_seq + 1;
        INSERT INTO finance.bank_transaction (
          id, bank_account_id, condominium_id,
          transaction_date, value_date, amount, description, status
        )
        VALUES (
          'bt_max_' || c_idx || '_' || yr || lpad(m::text, 2, '0') || '_in',
          'ba_max_' || c_idx,
          'condo_max_' || c_idx,
          make_date(yr, m, 10),
          make_date(yr, m, 10),
          200000 + (c_idx * 50000),  -- 2.000-4.500€ por depósito
          'TRF SEPA - Depósito quotas ' || lpad(m::text, 2, '0') || '/' || yr,
          CASE WHEN yr < EXTRACT(YEAR FROM CURRENT_DATE)::int THEN 'reconciled' ELSE 'unreconciled' END
        )
        ON CONFLICT (id) DO NOTHING;

        -- Movimento 2: saída (pagamento a fornecedor genérico).
        INSERT INTO finance.bank_transaction (
          id, bank_account_id, condominium_id,
          transaction_date, value_date, amount, description, status
        )
        VALUES (
          'bt_max_' || c_idx || '_' || yr || lpad(m::text, 2, '0') || '_out',
          'ba_max_' || c_idx,
          'condo_max_' || c_idx,
          make_date(yr, m, 25),
          make_date(yr, m, 25),
          -(80000 + (c_idx * 10000)),  -- 800-1.300€ saída
          'PAG SEPA - Despesas gerais ' || lpad(m::text, 2, '0') || '/' || yr,
          'unreconciled'
        )
        ON CONFLICT (id) DO NOTHING;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;
