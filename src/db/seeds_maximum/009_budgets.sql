-- 009_budgets.sql - 1 budget aprovado por (condomínio × ano), 2020 a 2026.
-- 5 condos × 7 anos = 35 budgets.
--
-- Cada budget tem uma única budget_line apontando à conta custom de
-- "Despesas Gerais" do condomínio. Valor anual proporcional ao tamanho
-- do condomínio (mais frações = mais despesa anual).

DO $$
DECLARE
  c_idx int;
  n_units int;
  yr int;
  bg_id text;
  annual_amount int;  -- em cêntimos
BEGIN
  FOR c_idx, n_units IN VALUES (1, 80), (2, 15), (3, 100), (4, 30), (5, 50) LOOP
    FOR yr IN 2020..2026 LOOP
      bg_id := 'bg_max_' || c_idx || '_' || yr;
      -- Valor anual: 1.000€ × nº frações (ex: 80 frações = 80.000€/ano).
      -- Em cêntimos: 100_000 × n_units.
      annual_amount := 100000 * n_units;

      INSERT INTO core.budget (
        id, condominium_id, year, type, status, fcr_percentage, approved_at
      )
      VALUES (
        bg_id,
        'condo_max_' || c_idx,
        yr,
        'principal',
        'approved',
        10,
        ((yr - 1) || '-12-15 19:00:00+00')::timestamptz   -- aprovado em Dezembro do ano anterior
      )
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO core.budget_line (budget_id, account_id, annual_amount)
      VALUES (bg_id, 'coa_max_' || c_idx, annual_amount)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;
