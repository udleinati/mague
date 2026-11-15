-- 011_charges_payable.sql - despesas a fornecedores (payable).
--
-- Volume: 5 condomínios × 5 fornecedores × 12 meses × 7 anos = 2.100
-- charges payable.
--
-- Cada despesa é mensal, distribuída pelos 12 meses do ano. Valores
-- variam por categoria (manutenção é mais cara que limpeza).

DO $$
DECLARE
  c_idx int;
  yr int;
  m int;
  i int;
  supplier_codes text[] := ARRAY['lim', 'edp', 'ele', 'gas', 'man'];
  supplier_amounts int[] := ARRAY[15000, 8000, 25000, 6000, 30000];  -- cêntimos
  supplier_descs text[] := ARRAY[
    'Serviço de limpeza',
    'Energia elétrica',
    'Manutenção elevadores',
    'Gás natural',
    'Manutenção geral'
  ];
BEGIN
  FOR c_idx IN 1..5 LOOP
    FOR yr IN 2020..2026 LOOP
      FOR m IN 1..12 LOOP
        FOR i IN 1..5 LOOP
          INSERT INTO finance.charge (
            id, condominium_id, supplier_id, scope, nature, charge_type, kind, status,
            issue_date, due_date, competence_period, account_id,
            original_amount, expected_amount, open_amount,
            description, created_at
          )
          VALUES (
            'ch_max_d_' || c_idx || '_' || supplier_codes[i] || '_' || yr || lpad(m::text, 2, '0'),
            'condo_max_' || c_idx,
            'sup_max_' || c_idx || '_' || supplier_codes[i],
            'condominium',
            'debit',
            'supplier_service',
            'payable',
            'open',
            make_date(yr, m, 5),                 -- recebida no dia 5
            make_date(yr, m, 25),                -- pagar até dia 25
            make_date(yr, m, 1),
            'coa_max_' || c_idx,
            supplier_amounts[i],
            supplier_amounts[i],
            supplier_amounts[i],
            supplier_descs[i] || ' ' || lpad(m::text, 2, '0') || '/' || yr,
            (make_date(yr, m, 5) + INTERVAL '10 hours')::timestamptz
          )
          ON CONFLICT (id) DO NOTHING;
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;
