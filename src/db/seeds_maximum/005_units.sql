-- 005_units.sql - 275 frações distribuídas pelos 5 condomínios.
--
-- Tamanhos por condomínio:
--   condo_max_1 → 80 frações
--   condo_max_2 → 15 frações
--   condo_max_3 → 100 frações
--   condo_max_4 → 30 frações
--   condo_max_5 → 50 frações
--
-- Designação: A, B, C, …, Z, AA, AB, …, AZ, BA, BB, …, BZ, CA, …, CV
-- (regra natural: comprimento ASC, alfabético dentro do mesmo comprimento -
-- igual ao `unitNaturalOrder` em libs/postgres/order_by.ts).
--
-- ID: `unit_max_<condo_idx>_<seq:03d>` (ex: unit_max_3_001 .. unit_max_3_100)
-- Permilagem: distribuída uniformemente entre 1000 (soma deve dar 1000 por
-- condomínio para os triggers de quota funcionarem). Cálculo simples:
-- `1000.000 / N` por unit, com a última a absorver o resto via FLOOR.

DO $$
DECLARE
  c_idx int;
  n int;
  total_units int;
  permillage_each numeric;
  permillage_last numeric;
  i int;
  desig text;
  permillage_to_use numeric;
  unit_id text;
  condo_id text;
BEGIN
  -- Para cada condomínio, gerar as suas N frações.
  FOR c_idx, n IN VALUES (1, 80), (2, 15), (3, 100), (4, 30), (5, 50) LOOP
    condo_id := 'condo_max_' || c_idx;
    total_units := n;
    permillage_each := FLOOR((1000.0 / n)::numeric * 1000) / 1000;  -- 3 dec
    permillage_last := 1000 - permillage_each * (n - 1);

    FOR i IN 1..n LOOP
      -- Designação natural: 1→A, 2→B, …, 26→Z, 27→AA, 28→AB, …
      IF i <= 26 THEN
        desig := chr(64 + i);  -- A=65, …, Z=90
      ELSE
        desig := chr(64 + ((i - 1) / 26)) || chr(65 + ((i - 1) % 26));
      END IF;

      unit_id := 'unit_max_' || c_idx || '_' || lpad(i::text, 3, '0');
      permillage_to_use := CASE WHEN i = n THEN permillage_last ELSE permillage_each END;

      INSERT INTO core.unit (id, condominium_id, unit_type, designation, permillage,
                             floor, door, is_active)
      VALUES (
        unit_id,
        condo_id,
        'residential',
        desig,
        permillage_to_use,
        ((i - 1) / 4 + 1)::text,                            -- 4 frações por andar (ish)
        CASE WHEN i % 2 = 1 THEN 'Esq' ELSE 'Dto' END,
        true
      )
      ON CONFLICT (id) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;
