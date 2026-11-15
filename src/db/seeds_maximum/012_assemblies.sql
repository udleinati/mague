-- 012_assemblies.sql - 2 assembleias por (condomínio × ano):
-- ordinária (Fevereiro, held) e extraordinária (Junho, held se já passou,
-- scheduled se for futuro).
--
-- Total: 5 condos × 7 anos × 2 = 70 assembleias.

DO $$
DECLARE
  c_idx int;
  yr int;
  ord_id text;
  ext_id text;
  ord_status text;
  ext_status text;
  today_year int := EXTRACT(YEAR FROM CURRENT_DATE)::int;
BEGIN
  FOR c_idx IN 1..5 LOOP
    FOR yr IN 2020..2026 LOOP
      ord_id := 'ass_max_' || c_idx || '_ord_' || yr;
      ext_id := 'ass_max_' || c_idx || '_ext_' || yr;

      -- Assembleia ordinária: Fevereiro. Held se ano já passou ou estamos
      -- em Março+ do ano corrente.
      ord_status := CASE
        WHEN yr < today_year THEN 'held'
        WHEN yr = today_year AND CURRENT_DATE >= make_date(yr, 3, 1) THEN 'held'
        ELSE 'scheduled'
      END;

      INSERT INTO core.assembly (
        id, condominium_id, type, scheduled_at, held_at, location, status, notes
      )
      VALUES (
        ord_id, 'condo_max_' || c_idx, 'ordinary',
        make_date(yr, 2, 10) + INTERVAL '19 hours',
        CASE WHEN ord_status = 'held' THEN make_date(yr, 2, 10) + INTERVAL '19 hours 30 minutes' END,
        'Salão do condomínio',
        ord_status,
        'Assembleia ordinária ' || yr || ' - aprovação contas e orçamento'
      )
      ON CONFLICT (id) DO NOTHING;

      -- Assembleia extraordinária: Junho.
      ext_status := CASE
        WHEN yr < today_year THEN 'held'
        WHEN yr = today_year AND CURRENT_DATE >= make_date(yr, 7, 1) THEN 'held'
        ELSE 'scheduled'
      END;

      INSERT INTO core.assembly (
        id, condominium_id, type, scheduled_at, held_at, location, status, notes
      )
      VALUES (
        ext_id, 'condo_max_' || c_idx, 'extraordinary',
        make_date(yr, 6, 15) + INTERVAL '19 hours',
        CASE WHEN ext_status = 'held' THEN make_date(yr, 6, 15) + INTERVAL '19 hours 30 minutes' END,
        'Online (Zoom)',
        ext_status,
        'Assembleia extraordinária ' || yr || ' - obras urgentes'
      )
      ON CONFLICT (id) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;
