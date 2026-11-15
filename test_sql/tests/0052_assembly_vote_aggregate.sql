-- 0052_assembly_vote_aggregate.sql
--
-- Trigger AFTER INSERT/UPDATE/DELETE `fn_assembly_vote_aggregate`
-- (component 011): mantém os totais em `core.assembly_agenda_item.votes_*`
-- automaticamente em sync com `core.assembly_vote`.
--
-- Cobre:
--   1. INSERT votes → totals agregados correctos por categoria.
--   2. INSERT múltiplos votos → soma cumulativa.
--   3. UPDATE de voto (favor → against) → realoca permilagem.
--   4. UPDATE mudando assembly_agenda_item_id → ambas as decisions reagregadas.
--   5. DELETE (soft) → permilagem removida da soma.
--   6. Soft-deleted (`deleted_at IS NOT NULL`) NÃO conta para os totais.

BEGIN;
SELECT plan(11);

-- ═══ Setup ════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_va', 'Vote aggregate test');
INSERT INTO core.unit (id, condominium_id, designation, permillage)
  VALUES ('u_va_a', 'cd_va', 'A', 300),
         ('u_va_b', 'cd_va', 'B', 200),
         ('u_va_c', 'cd_va', 'C', 500);
INSERT INTO core.assembly (id, condominium_id, type, scheduled_at)
  VALUES ('a_va', 'cd_va', 'ordinary', '2026-03-15 19:00:00+00');
INSERT INTO core.assembly_agenda_item (id, assembly_id, sequence, subject)
  VALUES ('d_va_1', 'a_va', 1, 'decision 1'),
         ('d_va_2', 'a_va', 2, 'decision 2');

-- ═══ Test 1: INSERT - votos a favor agregados ═══════════════════════════
INSERT INTO core.assembly_vote (id, assembly_agenda_item_id, unit_id, vote, permillage_applied)
  VALUES ('v1', 'd_va_1', 'u_va_a', 'favor', 300);

SELECT is(
  (SELECT votes_in_favor FROM core.assembly_agenda_item WHERE id='d_va_1'),
  300.000::numeric,
  'INSERT favor 300 → votes_in_favor=300'
);

-- ═══ Test 2: INSERT múltiplos → soma cumulativa ══════════════════════════
INSERT INTO core.assembly_vote (id, assembly_agenda_item_id, unit_id, vote, permillage_applied)
  VALUES ('v2', 'd_va_1', 'u_va_b', 'against', 200),
         ('v3', 'd_va_1', 'u_va_c', 'abstain', 500);

SELECT is(
  (SELECT votes_in_favor FROM core.assembly_agenda_item WHERE id='d_va_1'),
  300.000::numeric,
  'votes_in_favor mantém 300 (só u_va_a votou favor)'
);
SELECT is(
  (SELECT votes_against FROM core.assembly_agenda_item WHERE id='d_va_1'),
  200.000::numeric,
  'votes_against = 200 (u_va_b)'
);
SELECT is(
  (SELECT votes_abstain FROM core.assembly_agenda_item WHERE id='d_va_1'),
  500.000::numeric,
  'votes_abstain = 500 (u_va_c)'
);

-- ═══ Test 3: UPDATE - muda voto favor → against (realoca permilagem) ═════
UPDATE core.assembly_vote SET vote='against' WHERE id='v1';

SELECT is(
  (SELECT votes_in_favor FROM core.assembly_agenda_item WHERE id='d_va_1'),
  0.000::numeric,
  'após UPDATE favor→against: votes_in_favor cai para 0'
);
SELECT is(
  (SELECT votes_against FROM core.assembly_agenda_item WHERE id='d_va_1'),
  500.000::numeric,
  'votes_against agora 500 (200 original + 300 do realocado)'
);

-- ═══ Test 4: UPDATE muda assembly_agenda_item_id - ambas reagregadas ═══════
UPDATE core.assembly_vote SET assembly_agenda_item_id='d_va_2' WHERE id='v3';

SELECT is(
  (SELECT votes_abstain FROM core.assembly_agenda_item WHERE id='d_va_1'),
  0.000::numeric,
  'd_va_1 perde votes_abstain (voto migrou)'
);
SELECT is(
  (SELECT votes_abstain FROM core.assembly_agenda_item WHERE id='d_va_2'),
  500.000::numeric,
  'd_va_2 ganha votes_abstain=500 (voto migrado)'
);

-- ═══ Test 5: DELETE físico → permilagem removida ════════════════════════
DELETE FROM core.assembly_vote WHERE id='v2';

SELECT is(
  (SELECT votes_against FROM core.assembly_agenda_item WHERE id='d_va_1'),
  300.000::numeric,
  'após DELETE de v2 (200‰ contra), votes_against = 300 (só v1)'
);

-- ═══ Test 6: Soft-delete não conta para totais ═══════════════════════════
UPDATE core.assembly_vote SET deleted_at=now() WHERE id='v1';

SELECT is(
  (SELECT votes_against FROM core.assembly_agenda_item WHERE id='d_va_1'),
  0.000::numeric,
  'voto soft-deleted (deleted_at NOT NULL) não conta para o agregado'
);

-- Re-activar (set deleted_at=NULL) deveria voltar a contar.
UPDATE core.assembly_vote SET deleted_at=NULL WHERE id='v1';

SELECT is(
  (SELECT votes_against FROM core.assembly_agenda_item WHERE id='d_va_1'),
  300.000::numeric,
  'voto re-activado (deleted_at=NULL) volta a contar'
);

SELECT * FROM finish();
ROLLBACK;
