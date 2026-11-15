-- 0049_documents.sql - invariantes do core.document.
--
-- Cobre:
--   1. Multi-tenant: FK condominium_id obrigatório.
--   2. Categoria CHECK constraint (allow-list fechada).
--   3. is_public default false.
--   4. published_at default CURRENT_DATE.
--   5. attachment entity_type='document' agora aceito.
--   6. Audit attach automático ao INSERT (event trigger).
--   7. Soft-delete preserva row.

BEGIN;
SELECT plan(12);

-- Setup
INSERT INTO core.condominium (id, name) VALUES ('cd_doc', 'Doc Test');
INSERT INTO core.condominium (id, name) VALUES ('cd_doc2', 'Other Tenant');

-- ═══ 1: INSERT mínimo aceita ═══════════════════════════════════════════════
INSERT INTO core.document (id, condominium_id, title, created_by)
  VALUES ('d1', 'cd_doc', 'Acta 2026', '{"id":"u"}'::jsonb);
SELECT is(
  (SELECT title FROM core.document WHERE id = 'd1'),
  'Acta 2026',
  'Documento mínimo persiste'
);

-- ═══ 2: Defaults aplicados ═════════════════════════════════════════════════
SELECT is(
  (SELECT category FROM core.document WHERE id = 'd1'),
  'other',
  'category default = other'
);
SELECT is(
  (SELECT is_public FROM core.document WHERE id = 'd1'),
  false,
  'is_public default = false (privado)'
);
SELECT is(
  (SELECT published_at FROM core.document WHERE id = 'd1'),
  CURRENT_DATE,
  'published_at default = hoje'
);
-- ═══ 3: Categoria fora do allow-list rejeita ════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.document (condominium_id, title, category, created_by)
     VALUES ('cd_doc', 'X', 'invalid_cat', '{"id":"u"}'::jsonb) $$,
  '23514',
  NULL,
  'category fora do allow-list rejeitado pela CHECK'
);

-- ═══ 4: Multi-tenant - INSERT em condomínio inexistente rejeita ═════════════
SELECT throws_ok(
  $$ INSERT INTO core.document (condominium_id, title, created_by)
     VALUES ('cd_inexistente', 'X', '{"id":"u"}'::jsonb) $$,
  '23503',
  NULL,
  'FK condominium_id rejeita id inválido'
);

-- ═══ 5: attachment entity_type='document' agora aceito ═════════════════════
SELECT lives_ok(
  $$ INSERT INTO core.attachment (condominium_id, entity_type, entity_id,
                                   filename, mime_type, storage_key,
                                   file_size, created_by)
     VALUES ('cd_doc', 'document', 'd1', 'acta.pdf', 'application/pdf',
             'cd_doc/documents/d1/x.pdf', 1024, '{"id":"u"}'::jsonb) $$,
  'attachment.entity_type=document é aceito'
);

-- ═══ 6: Soft-delete preserva row ═══════════════════════════════════════════
UPDATE core.document SET deleted_at = NOW() WHERE id = 'd1';
SELECT is(
  (SELECT count(*)::int FROM core.document WHERE id = 'd1'),
  1,
  'Soft-delete preserva row (não DELETE físico)'
);

-- ═══ 7: Cross-tenant - document de outro condo NÃO aparece em filtro ═══════
INSERT INTO core.document (id, condominium_id, title, created_by)
  VALUES ('d2', 'cd_doc2', 'Outro tenant', '{"id":"u"}'::jsonb);
SELECT is(
  (SELECT count(*)::int FROM core.document
   WHERE condominium_id = 'cd_doc' AND deleted_at IS NULL),
  0,
  'Filtro por cid não devolve documents de outro tenant'
);

-- ═══ 8: Audit attach automático ═════════════════════════════════════════════
SELECT is(
  (SELECT count(*)::int FROM audit.cdc_log
   WHERE table_name = 'document' AND row_id = 'd1'),
  2, -- 1 INSERT + 1 UPDATE (soft-delete)
  'Audit captou INSERT + UPDATE no documento'
);

-- ═══ 9: is_public toggle reflete na query ═══════════════════════════════════
INSERT INTO core.document (id, condominium_id, title, is_public, created_by)
  VALUES ('d3', 'cd_doc', 'Publico', true, '{"id":"u"}'::jsonb);
SELECT is(
  (SELECT is_public FROM core.document WHERE id = 'd3'),
  true,
  'is_public=true persistido'
);
SELECT is(
  (SELECT count(*)::int FROM core.document
   WHERE condominium_id = 'cd_doc' AND is_public = true AND deleted_at IS NULL),
  1,
  'Filtro is_public=true devolve só públicos (1 row)'
);

SELECT * FROM finish();
ROLLBACK;
