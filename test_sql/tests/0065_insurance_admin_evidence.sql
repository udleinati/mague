-- 0065_insurance_admin_evidence.sql
--
-- Documento entregue à administração fora do portal: o terceiro estado de
-- evidência (`core.insurance_policy.evidence_source`), ADR 0016.
--
-- Cobre o que só a BD garante:
--   • CHECK de `evidence_source` - o enum e o NULL, que é a renovação presumida
--   • A renovação com documento deixa o predecessor `active` até à aprovação,
--     e é o approve que fecha o par (superseded + active), nunca duas activas
--   • A view expõe as duas keys que compõem `isAdminDocumented` em TS
--   • O audit trail regista a origem da evidência - é o que sobra do princípio
--     do ADR 0016 depois de o admin passar a poder registar documentos
--
-- Fora de alcance aqui: que cada caminho de escrita grave o valor certo
-- ('unit' no portal, 'admin' no renew e no criar do admin). Isso é código TS e
-- não há constraint que o obrigue - vive nos testes de unidade de `upload.ts` e
-- `state.ts` e nos smokes das Fases 3, 4 e 6.
--
-- Nota: throws_ok apanha a exceção numa subtransação interna, por isso não
-- precisa de SAVEPOINT externo.

BEGIN;
SELECT plan(12);

-- ═══ Setup ════════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_iae', 'Insurance Admin Evidence');
INSERT INTO core.unit (id, condominium_id, designation, permillage, is_active)
  VALUES ('u_chk',  'cd_iae', 'CHECK',  100, true),
         ('u_ren',  'cd_iae', 'Renova', 100, true),
         ('u_raiz', 'cd_iae', 'Raiz',   100, true);

-- ═══ Test 1: CHECK bloqueia origem fora de {unit, admin} ══════════════════════
-- A coluna é a fronteira entre "a fração documentou" e "a administração
-- registou". Um terceiro valor a entrar sem revisão do domínio faria os
-- predicados de TS caírem no ramo errado sem ninguém dar por isso.
SELECT throws_ok(
  $$ INSERT INTO core.insurance_policy
       (condominium_id, unit_id, valid_from, valid_to, uploaded_by, evidence_source)
     VALUES ('cd_iae', 'u_chk', '2026-01-01', '2027-01-01', '{"id":"u"}'::jsonb, 'gestor') $$,
  '23514',
  NULL,
  'CHECK evidence_source bloqueia valor fora de unit|admin'
);

-- ═══ Test 2: NULL continua a caber - é a renovação presumida ══════════════════
-- Um NOT NULL por engano partia o caminho antigo do ADR 0016 (renovar sem
-- documento cria uma `active` com `presumed_at` e sem evidência nenhuma).
INSERT INTO core.insurance_policy
  (id, condominium_id, unit_id, status, valid_from, valid_to, uploaded_by, presumed_at)
VALUES ('pol_pres', 'cd_iae', 'u_chk', 'active', '2026-01-01', '2027-01-01',
        '{"id":"u"}'::jsonb, now());

SELECT ok(
  (SELECT evidence_source IS NULL FROM core.insurance_policy WHERE id='pol_pres'),
  'renovação presumida grava evidence_source NULL - sem documento não há origem'
);

-- ═══ Test 3: os dois valores do enum persistem ════════════════════════════════
INSERT INTO core.insurance_policy
  (id, condominium_id, unit_id, status, valid_from, valid_to, uploaded_by, evidence_source)
VALUES ('pol_u', 'cd_iae', 'u_chk', 'pending_review', '2026-01-01', '2027-01-01',
        '{"id":"u"}'::jsonb, 'unit'),
       ('pol_a', 'cd_iae', 'u_chk', 'pending_review', '2026-01-01', '2027-01-01',
        '{"id":"u"}'::jsonb, 'admin');

SELECT results_eq(
  $$ SELECT id::text, evidence_source::text FROM core.insurance_policy
      WHERE id IN ('pol_u','pol_a') ORDER BY id $$,
  $$ VALUES ('pol_a'::text, 'admin'::text), ('pol_u'::text, 'unit'::text) $$,
  'unit e admin são ambos aceites - são os dois lados da distinção'
);

-- ═══ Setup da renovação com documento ═════════════════════════════════════════
-- Predecessor documentado pela fração no portal, a chegar ao fim da vigência.
INSERT INTO core.insurance_policy
  (id, condominium_id, unit_id, status, valid_from, valid_to, uploaded_by, created_by,
   evidence_source, confirmed_at, confirmed_by, approved_at, approved_by, created_at)
VALUES ('pol_pred', 'cd_iae', 'u_ren', 'active', '2025-07-01', '2026-07-01',
        '{"user_id":"occ_1"}'::jsonb, '{"user_id":"occ_1"}'::jsonb, 'unit',
        now(), '{"user_id":"occ_1"}'::jsonb, now(), '{"user_id":"adm_1"}'::jsonb,
        '2025-06-20 10:00:00+00');

-- Renovação com o documento que o admin recebeu por email: nasce
-- `pending_review`, sem `presumed_at` (há papel), e não substitui a antiga.
INSERT INTO core.insurance_policy
  (id, condominium_id, unit_id, status, valid_from, valid_to, uploaded_by, created_by,
   evidence_source, renewed_from_id, created_at)
VALUES ('pol_novo', 'cd_iae', 'u_ren', 'pending_review', '2026-07-01', '2027-07-01',
        '{"user_id":"adm_1"}'::jsonb, '{"user_id":"adm_1"}'::jsonb, 'admin', 'pol_pred',
        '2026-06-25 10:00:00+00');

INSERT INTO core.attachment
  (id, condominium_id, entity_type, entity_id, filename, mime_type, storage_key, file_size, created_by)
VALUES ('att_novo', 'cd_iae', 'insurance', 'pol_novo', 'apolice-2026.pdf', 'application/pdf',
        'cd_iae/insurance/p/o/pol_novo/att_novo-apolice-2026.pdf', 42000,
        '{"user_id":"adm_1"}'::jsonb);

-- ═══ Test 4: durante a revisão, o predecessor fica active ═════════════════════
-- Superseder já era o reflexo natural (é o que a renovação presumida faz), e
-- estava errado: a fração caía para `awaiting_approval` e o painel dava por
-- descoberta uma fração que tem cobertura válida até 2026-07-01.
SELECT results_eq(
  $$ SELECT id::text, status::text FROM core.insurance_policy
      WHERE unit_id='u_ren' ORDER BY id $$,
  $$ VALUES ('pol_novo'::text, 'pending_review'::text),
            ('pol_pred'::text, 'active'::text) $$,
  'renovar com documento: predecessor continua active, a nova espera revisão'
);

-- ═══ Test 5: e por isso a fração tem exatamente uma active ════════════════════
SELECT is(
  (SELECT count(*)::int FROM core.insurance_policy
    WHERE unit_id='u_ren' AND status='active'),
  1,
  'uma só active durante a revisão - o KPI da fração não baixa por registar o documento'
);

-- ═══ Test 6: a linhagem não se apaga por baixo ════════════════════════════════
-- ADR 0040. O estado interino é novo (predecessor active + sucessora
-- pending_review) e não abre buraco: o RESTRICT continua a valer.
SELECT throws_ok(
  $$ DELETE FROM core.insurance_policy WHERE id='pol_pred' $$,
  '23001',
  NULL,
  'ON DELETE RESTRICT bloqueia apagar o predecessor enquanto a renovação espera revisão'
);

-- ═══ Setup: o approve, como a transação de approveInsurancePolicy o faz ═══════
UPDATE core.insurance_policy
   SET status='active', approved_at=now(), approved_by='{"user_id":"adm_1"}'::jsonb,
       confirmed_at=now(), confirmed_by='{"user_id":"adm_1"}'::jsonb,
       updated_by='{"user_id":"adm_1"}'::jsonb
 WHERE id='pol_novo';

UPDATE core.insurance_policy
   SET status='superseded', superseded_at=now(), updated_by='{"user_id":"adm_1"}'::jsonb
 WHERE id='pol_pred' AND status='active';

-- ═══ Test 7: é a aprovação que fecha o par ════════════════════════════════════
SELECT results_eq(
  $$ SELECT id::text, status::text FROM core.insurance_policy
      WHERE unit_id='u_ren' ORDER BY id $$,
  $$ VALUES ('pol_novo'::text, 'active'::text),
            ('pol_pred'::text, 'superseded'::text) $$,
  'aprovar ativa a nova e substitui o predecessor - o supersede é aqui, não no renew'
);

-- ═══ Test 8: e nunca há duas activas ao mesmo tempo ═══════════════════════════
SELECT is(
  (SELECT count(*)::int FROM core.insurance_policy
    WHERE unit_id='u_ren' AND status='active'),
  1,
  'depois de aprovar continua a haver exatamente uma active'
);

-- ═══ Test 9: a view expõe as keys que isAdminDocumented compõe ════════════════
-- `isAdminDocumented` em TS é `evidenceSource === 'admin' && attachmentCount > 0`.
-- Se a view deixasse cair `evidenceSource`, `classifyPolicy` voltava a ler a
-- apólice do admin como "aguarda o condómino" e o admin ficava sem o botão de
-- aprovar. Pinning das keys camelCase.
SELECT is(
  (SELECT (policies->0) ?& ARRAY['evidenceSource','attachmentCount']
     FROM core.vw_unit_insurance_status WHERE unit_id='u_ren'),
  true,
  'JSONB da view tem evidenceSource e attachmentCount (camelCase)'
);

-- ═══ Test 10: e com os valores que fazem o predicado dar verdadeiro ═══════════
-- policies vem ordenado created_at DESC, logo policies->0 é a renovação.
SELECT results_eq(
  $$ SELECT policies->0->>'id', policies->0->>'evidenceSource',
            (policies->0->>'attachmentCount')::int
       FROM core.vw_unit_insurance_status WHERE unit_id='u_ren' $$,
  $$ VALUES ('pol_novo'::text, 'admin'::text, 1) $$,
  'a apólice do admin chega ao read-model como admin + 1 anexo'
);

-- ═══ Test 11: o audit regista a origem da evidência ═══════════════════════════
-- O ADR 0016 apoiava-se em "o admin não produz prova da fração". Agora produz,
-- marcada - e o que fica a distinguir os dois casos numa disputa é o cdc_log.
-- Em INSERT o diff é NULL (não há antes); o estado vai no snapshot.
SELECT is(
  (SELECT snapshot->>'evidence_source' FROM audit.cdc_log
    WHERE table_name='insurance_policy' AND row_id='pol_novo' AND action='insert'),
  'admin',
  'cdc_log guarda evidence_source no INSERT - a origem é auditável'
);

-- ═══ Setup: criação de raiz numa fração que já tinha um draft por rever ═══════
INSERT INTO core.insurance_policy
  (id, condominium_id, unit_id, status, valid_from, valid_to, uploaded_by, created_by, evidence_source)
VALUES ('pol_draft', 'cd_iae', 'u_raiz', 'pending_review', '2026-01-01', '2027-01-01',
        '{"user_id":"adm_1"}'::jsonb, '{"user_id":"adm_1"}'::jsonb, 'admin');

INSERT INTO core.insurance_policy
  (id, condominium_id, unit_id, status, valid_from, valid_to, uploaded_by, created_by, evidence_source)
VALUES ('pol_raiz', 'cd_iae', 'u_raiz', 'pending_review', '2026-03-01', '2027-03-01',
        '{"user_id":"adm_1"}'::jsonb, '{"user_id":"adm_1"}'::jsonb, 'admin');

-- ═══ Test 12: criar de raiz não mexe em mais nada da fração ═══════════════════
-- Sem predecessor não há `renewed_from_id`, e a limpeza de drafts do mesmo
-- uploader é do portal (`evidenceSource === 'unit'`): a BD não a faz por
-- baixo. Se algum dia virasse trigger, apagaria o draft do admin em hard-delete
-- e deixava o objeto S3 órfão, contra o ADR 0021.
SELECT results_eq(
  $$ SELECT id::text, status::text, renewed_from_id::text FROM core.insurance_policy
      WHERE unit_id='u_raiz' ORDER BY id $$,
  $$ VALUES ('pol_draft'::text, 'pending_review'::text, NULL::text),
            ('pol_raiz'::text,  'pending_review'::text, NULL::text) $$,
  'criar de raiz nasce sem linhagem e deixa o draft anterior intacto'
);

SELECT * FROM finish();
ROLLBACK;
