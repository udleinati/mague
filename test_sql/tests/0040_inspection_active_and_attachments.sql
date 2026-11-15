-- 0040_inspection_active_and_attachments.sql
--
-- Valida is_active em inspection + unified attachment:
--   • is_active default true em inspection
--   • core.attachment polimórfica suporta entity_type='inspection'
--   • Audit captura INSERT/UPDATE/soft-delete na nova tabela
--
-- Nota: não há CASCADE delete na hard-delete de inspection (core.attachment
-- não tem FK directa ao pai); o cleanup é feito via app code.

BEGIN;
SELECT plan(9);

-- ═══ Setup ════════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_iat', 'Inspect+Att Test');
INSERT INTO core.inspection (id, condominium_id, category, description, valid_until, created_by)
VALUES ('insp_a1', 'cd_iat', 'elevator', 'Elevador A',
        '2099-12-31', '{"id":"u_t","email":"u@x.pt"}'::jsonb);

-- ═══ Test 1: is_active default true ═══════════════════════════════════════════
SELECT is(
  (SELECT is_active FROM core.inspection WHERE id='insp_a1'),
  true,
  'INSERT mínimo: is_active default = true'
);

-- ═══ Test 2: UPDATE is_active = false persiste ════════════════════════════════
UPDATE core.inspection
   SET is_active = false,
       updated_by = '{"id":"u_t"}'::jsonb,
       updated_at = now()
 WHERE id = 'insp_a1';
SELECT is(
  (SELECT is_active FROM core.inspection WHERE id='insp_a1'),
  false,
  'UPDATE: is_active = false persistido'
);

-- ═══ Test 3: audit captura UPDATE de is_active no diff ═══════════════════════
SELECT is(
  (SELECT diff->'after'->>'is_active' FROM audit.cdc_log
     WHERE table_name='inspection' AND row_id='insp_a1' AND action='update'
     ORDER BY id DESC LIMIT 1),
  'false',
  'audit: diff.after.is_active reflete desactivação'
);

-- ═══ Test 4: query "alerta count" ignora is_active=false ══════════════════════
INSERT INTO core.inspection (id, condominium_id, category, description, valid_until, is_active, created_by)
VALUES
  ('insp_exp_active', 'cd_iat', 'gas', 'Gás vencido ativo', '2020-01-01', true, '{"id":"u"}'::jsonb),
  ('insp_exp_inactive', 'cd_iat', 'gas', 'Gás vencido desactivado', '2020-01-01', false, '{"id":"u"}'::jsonb);

SELECT is(
  (SELECT count(*)::int FROM core.inspection
     WHERE condominium_id='cd_iat'
       AND deleted_at IS NULL
       AND is_active = TRUE
       AND (valid_until <= CURRENT_DATE
            OR valid_until - notify_days_before <= CURRENT_DATE)),
  1,
  'alerta count: 1 vencida ativa, ignorando 1 vencida desactivada'
);

-- ═══ Test 5: INSERT em core.attachment (entity_type='inspection') ═══════════
INSERT INTO core.attachment (
  id, condominium_id, entity_type, entity_id, filename, mime_type,
  storage_key, file_size, created_by
) VALUES (
  'att_t1', 'cd_iat', 'inspection', 'insp_a1', 'cert-2026.pdf', 'application/pdf',
  'cd_iat/inspections/i/n/insp_a1/att_t1-cert-2026.pdf', 12345,
  '{"id":"u","email":"u@x.pt"}'::jsonb
);

SELECT is(
  (SELECT filename FROM core.attachment WHERE id='att_t1'),
  'cert-2026.pdf',
  'INSERT attachment persiste filename'
);

-- ═══ Test 6: 2º attachment na mesma inspeção (1:N polimórfico) ═════════════
INSERT INTO core.attachment (
  id, condominium_id, entity_type, entity_id, filename, mime_type,
  storage_key, file_size, created_by
) VALUES (
  'att_t2', 'cd_iat', 'inspection', 'insp_a1', 'foto.jpg', 'image/jpeg',
  'cd_iat/inspections/i/n/insp_a1/att_t2-foto.jpg', 99999,
  '{"id":"u"}'::jsonb
);

SELECT is(
  (SELECT count(*)::int FROM core.attachment
     WHERE entity_type='inspection' AND entity_id='insp_a1' AND deleted_at IS NULL),
  2,
  'attachment 1:N polimórfico: 2 anexos persistidos com entity_type=inspection'
);

-- ═══ Test 7: audit captou INSERT em core.attachment ═════════════════════════
SELECT cmp_ok(
  (SELECT count(*)::int FROM audit.cdc_log
     WHERE table_schema='core' AND table_name='attachment' AND row_id='att_t2'),
  '>=',
  1,
  'audit.cdc_log capturou INSERT em core.attachment'
);

-- ═══ Test 8: soft delete exclui da query "active" ═══════════════════════════
UPDATE core.attachment
   SET deleted_at = now(),
       deleted_by = '{"id":"u"}'::jsonb
 WHERE id = 'att_t1';
SELECT is(
  (SELECT count(*)::int FROM core.attachment
     WHERE entity_type='inspection' AND entity_id='insp_a1' AND deleted_at IS NULL),
  1,
  'soft delete: 1 anexo ativo restante'
);

-- ═══ Test 9: audit captou soft-delete (UPDATE com deleted_at) ═══════════════
SELECT isnt(
  (SELECT diff->'after'->>'deleted_at' FROM audit.cdc_log
     WHERE table_name='attachment' AND row_id='att_t1' AND action='update'
     ORDER BY id DESC LIMIT 1),
  NULL,
  'audit: soft-delete de attachment regista deleted_at no diff.after'
);

SELECT * FROM finish();
ROLLBACK;
