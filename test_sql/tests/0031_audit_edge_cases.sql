-- 0031_audit_edge_cases.sql
--
-- Casos não cobertos pelo 0030_audit:
--   • Actor via fallback `current_setting('app.user_id')` quando o row
--     foi inserido com `created_by='{}'` (default). Nota:
--     todas as tabelas auditadas têm actorColumns; o fallback GUC só fire
--     quando essas columns vêm vazias (`'{}'`).
--   • Actor em soft-delete: `deleted_by` deve sobrepor-se a `updated_by`
--     na resolução do actor.
--   • Quando nem actorColumn populada nem GUC, actor persiste como `'{}'`.
--
-- ADR 0011: actor JSONB tem `user_id` (não `id`) como chave do user. Tests
-- previamente testavam `id` - corrigido para `user_id`.

BEGIN;
SELECT plan(5);

-- ═══ Setup ════════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name)
  VALUES ('cd_audit_edge', 'Audit Edge Cases');

INSERT INTO core.unit (id, condominium_id, designation, permillage, is_active)
  VALUES ('u_edge', 'cd_audit_edge', 'A1', 1000, true);

-- ═══ Test 1: actor via GUC fallback quando created_by vem vazio ══════════════
-- core.assembly tem `created_by` JSONB com default '{}'.
-- Quando inserimos sem definir explicitamente o created_by, fica '{}'. O
-- trigger reconhece `actor='{}'` como "vazio" e cai no GUC fallback.
SET LOCAL app.user_id = 'usr_via_guc';
SET LOCAL app.user_email = 'guc@test.pt';
SET LOCAL app.ip = '10.0.0.1';

INSERT INTO core.assembly (id, condominium_id, type, scheduled_at, status)
  VALUES ('asm_edge', 'cd_audit_edge', 'ordinary', '2026-01-01', 'scheduled');

SELECT is(
  (SELECT actor->>'user_id' FROM audit.cdc_log
     WHERE table_name = 'assembly' AND row_id = 'asm_edge'
     ORDER BY id DESC LIMIT 1),
  'usr_via_guc',
  'actor.user_id veio de current_setting (GUC fallback) quando created_by={}'
);

SELECT is(
  (SELECT actor->>'email' FROM audit.cdc_log
     WHERE table_name = 'assembly' AND row_id = 'asm_edge'
     ORDER BY id DESC LIMIT 1),
  'guc@test.pt',
  'actor.email enriquecido a partir de app.user_email GUC'
);

RESET app.user_id;
RESET app.user_email;
RESET app.ip;

-- ═══ Test 2: actor em soft-delete prioriza deleted_by sobre updated_by ════════
-- core.unit tem ambos updated_by e deleted_by. Quando o UPDATE é um
-- soft-delete (deleted_at passa a NOT NULL), o trigger deve usar
-- deleted_by como fonte do actor - não updated_by.
UPDATE core.unit
   SET deleted_at = now(),
       updated_by = '{"id":"usr_who_updated","email":"upd@x.pt"}'::jsonb,
       deleted_by = '{"id":"usr_who_deleted","email":"del@x.pt"}'::jsonb
   WHERE id = 'u_edge';

SELECT is(
  (SELECT actor->>'id' FROM audit.cdc_log
     WHERE table_name = 'unit' AND row_id = 'u_edge' AND action = 'update'
     ORDER BY id DESC LIMIT 1),
  'usr_who_deleted',
  'soft-delete: actor vem de deleted_by, não de updated_by'
);

-- ═══ Test 3: snapshot continua a ter o estado pós-update (com deleted_at) ═════
SELECT isnt(
  (SELECT snapshot->>'deleted_at' FROM audit.cdc_log
     WHERE table_name = 'unit' AND row_id = 'u_edge' AND action = 'update'
     ORDER BY id DESC LIMIT 1),
  NULL,
  'snapshot.deleted_at NOT NULL após soft-delete'
);

-- ═══ Test 4: actor `'{}'::jsonb` quando nada está disponível ═══════════════
-- Sem GUC e com actorColumn=`'{}'`, o trigger não tem nada para preencher.
-- O actor persiste como `'{}'::jsonb` (não NULL - a coluna `created_by` da
-- assembly tem `NOT NULL DEFAULT '{}'`, e o audit reflete fielmente).
INSERT INTO core.assembly (id, condominium_id, type, scheduled_at, status)
  VALUES ('asm_no_actor', 'cd_audit_edge', 'ordinary', '2026-02-01', 'scheduled');

SELECT is(
  (SELECT actor FROM audit.cdc_log
     WHERE table_name = 'assembly' AND row_id = 'asm_no_actor'
     ORDER BY id DESC LIMIT 1),
  '{}'::jsonb,
  'actor = {} quando não há GUC nem actorColumn populada'
);

SELECT * FROM finish();
ROLLBACK;
