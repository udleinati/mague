-- 013_inspections.sql - inspeções periódicas por condomínio.
--
-- 5 categorias × 5 condos = 25 inspeções. Cada com `valid_until` no
-- futuro próximo (alguns vencidos, alguns OK, alguns due_soon) - útil
-- para testar o badge de alertas.

DO $$
DECLARE
  c_idx int;
  i int;
  cats text[] := ARRAY['fire_extinguisher', 'fire_detection', 'elevator', 'gas', 'electricity'];
  descs text[] := ARRAY[
    'Inspeção anual de extintores',
    'Manutenção do sistema de deteção de incêndio',
    'Inspeção bienal do elevador',
    'Inspeção da rede de gás',
    'Inspeção da instalação elétrica'
  ];
  -- Validade calculada para diversificar status:
  --   1ª: vencida (-30d)
  --   2ª: due_soon (+15d)
  --   3ª: ok (+90d)
  --   4ª: ok (+180d)
  --   5ª: ok (+270d)
  validity_offset int[] := ARRAY[-30, 15, 90, 180, 270];
BEGIN
  FOR c_idx IN 1..5 LOOP
    FOR i IN 1..5 LOOP
      INSERT INTO core.inspection (
        id, condominium_id, category, description, valid_until,
        last_done_date, notify_days_before, is_active, created_by
      )
      VALUES (
        'insp_max_' || c_idx || '_' || i,
        'condo_max_' || c_idx,
        cats[i],
        descs[i],
        CURRENT_DATE + (validity_offset[i] || ' days')::interval,
        CURRENT_DATE - INTERVAL '11 months',
        30,
        true,
        jsonb_build_object('id', 'u_super', 'email', 'super@mague.pt', 'ip', NULL)
      )
      ON CONFLICT (id) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;
