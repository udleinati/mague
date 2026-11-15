-- 006_occupants.sql + unit_occupants. 1 owner por fração.
--
-- Para metade das frações (par) o owner tem email - útil para testar
-- envio de lembretes, recibos, etc. A outra metade fica sem email.
--
-- IDs: `occ_max_<condo>_<seq>` e `uo_max_<condo>_<seq>` espelhando
-- o ID da unit para fácil debugging.

DO $$
DECLARE
  c_idx int;
  n int;
  i int;
  unit_id text;
  occ_id text;
  uo_id text;
  with_email boolean;
BEGIN
  FOR c_idx, n IN VALUES (1, 80), (2, 15), (3, 100), (4, 30), (5, 50) LOOP
    FOR i IN 1..n LOOP
      unit_id := 'unit_max_' || c_idx || '_' || lpad(i::text, 3, '0');
      occ_id := 'occ_max_' || c_idx || '_' || lpad(i::text, 3, '0');
      uo_id := 'uo_max_' || c_idx || '_' || lpad(i::text, 3, '0');
      with_email := (i % 2 = 0);  -- pares têm email

      INSERT INTO core.occupant (
        id, condominium_id, name, email, receive_receipt_emails
      )
      VALUES (
        occ_id,
        'condo_max_' || c_idx,
        'Proprietário ' || c_idx || '-' || i,
        CASE WHEN with_email THEN 'owner-' || c_idx || '-' || i || '@maguetest.pt' ELSE NULL END,
        with_email
      )
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO core.unit_occupant (
        id, unit_id, occupant_id, relationship_type, start_date
      )
      VALUES (
        uo_id,
        unit_id,
        occ_id,
        'owner',
        '2018-01-01'   -- todos owners desde 2018 (cobre 2020-2026 do seed)
      )
      ON CONFLICT (id) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;
