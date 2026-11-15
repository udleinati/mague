-- 0050_vw_unit_insurance_status.sql
--
-- Invariantes da view `core.vw_unit_insurance_status`: a regra de prioridade
-- vive em TS (selectPolicyForDisplay) e a view expõe TODAS as policies como
-- JSONB array.
--
-- Cobre:
--   1. Shape: coluna `policies` é JSONB array (não single-policy).
--   2. Unit sem policies → `policies = '[]'::jsonb` (empty array, não NULL).
--   3. Unit com 1 policy → array com 1 elemento.
--   4. Unit com N policies → array com N elementos (sem LIMIT 1 escondido).
--   5. Ordem estável `created_at DESC` (TS faz a final selection).
--   6. Multi-tenant: condominium_id segrega; uma unit em outro condo não
--      contamina a vista.
--   7. Soft-deleted units (`is_active=false` OU `deleted_at IS NOT NULL`)
--      excluídas da view.

BEGIN;
SELECT plan(8);

-- ═══ Setup ════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_vis', 'View Test');
INSERT INTO core.condominium (id, name) VALUES ('cd_vis2', 'Other Tenant');
INSERT INTO core.unit (id, condominium_id, designation, permillage, is_active)
  VALUES ('u_empty', 'cd_vis', 'Empty', 100, true),
         ('u_single', 'cd_vis', 'Single', 100, true),
         ('u_multi', 'cd_vis', 'Multi', 100, true),
         ('u_other', 'cd_vis2', 'Other', 100, true),
         ('u_inactive', 'cd_vis', 'Inactive', 100, false);

-- A apólice não tem `storage_key` (ficheiros vivem em
-- `core.attachment` polimórfica). `valid_from`/`valid_to` são NOT NULL.

-- u_single: 1 active.
INSERT INTO core.insurance_policy (id, condominium_id, unit_id,
  status, valid_from, valid_to, uploaded_by, created_at)
VALUES ('pol_s', 'cd_vis', 'u_single', 'active', '2026-01-01', '2027-12-31',
        '{"id":"u"}'::jsonb, '2026-01-01 10:00:00+00');

-- u_multi: 1 active + 1 pending_review (cenário de renovação).
INSERT INTO core.insurance_policy (id, condominium_id, unit_id,
  status, valid_from, valid_to, uploaded_by, created_at)
VALUES ('pol_a', 'cd_vis', 'u_multi', 'active', '2026-01-01', '2027-06-30',
        '{"id":"u"}'::jsonb, '2026-01-01 10:00:00+00'),
       ('pol_p', 'cd_vis', 'u_multi', 'pending_review', '2027-06-30', '2028-06-30',
        '{"id":"u"}'::jsonb, '2026-05-01 10:00:00+00');

-- u_other: 1 active no condo 2 (cross-tenant).
INSERT INTO core.insurance_policy (id, condominium_id, unit_id,
  status, valid_from, valid_to, uploaded_by)
VALUES ('pol_o', 'cd_vis2', 'u_other', 'active', '2026-01-01', '2027-12-31',
        '{"id":"u"}'::jsonb);

-- ═══ Test 1: shape da coluna policies = JSONB ═════════════════════════════
SELECT is(
  (SELECT pg_typeof(policies)::text FROM core.vw_unit_insurance_status
     WHERE unit_id='u_empty'),
  'jsonb',
  'coluna policies é JSONB'
);

-- ═══ Test 2: unit sem policies → empty array (não NULL) ═══════════════════
-- COALESCE(jsonb_agg, '[]') no view garante que callers nunca recebem NULL.
SELECT is(
  (SELECT policies FROM core.vw_unit_insurance_status WHERE unit_id='u_empty'),
  '[]'::jsonb,
  'unit sem policies → policies = []'
);

-- ═══ Test 3: unit com 1 policy → array com 1 elemento ════════════════════
SELECT is(
  (SELECT jsonb_array_length(policies) FROM core.vw_unit_insurance_status
     WHERE unit_id='u_single'),
  1,
  'unit com 1 policy → array length 1'
);

-- ═══ Test 4: unit com 2 policies → AMBAS expostas (sem LIMIT 1 escondido) ══
-- Foi exatamente o bug que o refactor corrigiu: antes a view fazia LIMIT 1
-- e escondia silenciosamente o pending_review sob a active.
SELECT is(
  (SELECT jsonb_array_length(policies) FROM core.vw_unit_insurance_status
     WHERE unit_id='u_multi'),
  2,
  'unit com 2 policies → array length 2 (sem LIMIT 1)'
);

-- ═══ Test 5: ordem estável `created_at DESC` ══════════════════════════════
-- O JSONB array vem ordenado pelo created_at DESC (mais recente primeiro).
-- TS faz a selection final por priority - a ordem aqui é só ajuda à
-- inspeção/debug.
SELECT is(
  (SELECT policies->0->>'id' FROM core.vw_unit_insurance_status
     WHERE unit_id='u_multi'),
  'pol_p',
  'array ordenado created_at DESC: pol_p (mais recente) primeiro'
);

-- ═══ Test 6: multi-tenant - condo2 não aparece na vista do condo1 ═════════
SELECT is(
  (SELECT count(*)::int FROM core.vw_unit_insurance_status
     WHERE condominium_id='cd_vis' AND unit_id='u_other'),
  0,
  'unit de outro condo não contamina a vista'
);

-- ═══ Test 7: u_inactive (is_active=false) excluída ═════════════════════════
SELECT is(
  (SELECT count(*)::int FROM core.vw_unit_insurance_status
     WHERE unit_id='u_inactive'),
  0,
  'unit com is_active=false excluída da view'
);

-- ═══ Test 8: keys camelCase no JSONB (consumido por classifyPolicy TS) ═════
-- O TS classifyPolicy lê `p.confirmedAt`, `p.validTo` (camelCase). A view
-- monta o JSONB com keys camelCase explícitas - se mudasse para snake_case
-- (auto via to_jsonb) o classify partiria silenciosamente. Pinning aqui.
SELECT is(
  (SELECT (policies->0) ?& ARRAY['validTo','confirmedAt','validFrom','status']
     FROM core.vw_unit_insurance_status WHERE unit_id='u_single'),
  true,
  'JSONB tem keys camelCase: validTo, confirmedAt, validFrom, status'
);

SELECT * FROM finish();
ROLLBACK;
