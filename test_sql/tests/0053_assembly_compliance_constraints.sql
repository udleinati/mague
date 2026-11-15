-- 0053_assembly_compliance_constraints.sql
--
-- Constraints SQL de compliance legal de assembleia.
-- Estas constraints são a última linha de defesa - mesmo que handler TS
-- ou caller falhem em validar, a DB rejeita.
--
-- Cobre:
--   1. assembly.convocation_round CHECK IN ('first', 'second').
--   2. assembly_minutes_signed_consistency: all-or-none entre president,
--      secretary, minutes_signed_at.
--   3. assembly.president/secretary FK para occupant.
--   4. assembly_attendee_proxy_consistency: is_proxy ↔ proxy_holder_occupant_id
--      (XOR proxy_holder_external_name).
--   5. assembly_attendee_permillage_positive.
--   6. assembly_attendee UNIQUE per (assembly_id, unit_id) WHERE NOT deleted.
--   7. assembly_vote_value_check IN ('favor', 'against', 'abstain').
--   8. assembly_vote_permillage_positive.
--   9. assembly_vote UNIQUE per (decision_id, unit_id) WHERE NOT deleted.
--
-- Nota: throws_ok apanha a excecao numa subtransacao interna, por isso nao
-- precisa de SAVEPOINT externo (que reverteria o contador interno do pgTAP).

BEGIN;
SELECT plan(17);

-- ═══ Setup ════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_ac', 'Constraint test');
INSERT INTO core.unit (id, condominium_id, designation, permillage)
  VALUES ('u_ac_a', 'cd_ac', 'A', 500), ('u_ac_b', 'cd_ac', 'B', 500);
INSERT INTO core.occupant (id, condominium_id, name)
  VALUES ('o_ac_p', 'cd_ac', 'President'),
         ('o_ac_s', 'cd_ac', 'Secretary'),
         ('o_ac_r', 'cd_ac', 'Represented');
INSERT INTO core.assembly (id, condominium_id, type, scheduled_at)
  VALUES ('a_ac', 'cd_ac', 'ordinary', '2026-04-01 19:00:00+00');
INSERT INTO core.assembly_agenda_item (id, assembly_id, sequence, subject)
  VALUES ('d_ac', 'a_ac', 1, 'subj');

-- ═══ Test 0a: status nasce em 'draft' (default da coluna) ═══════════════
-- O INSERT acima não passa `status` → a coluna assume o novo default.
SELECT is(
  (SELECT status FROM core.assembly WHERE id='a_ac'), 'draft',
  'assembly nasce em draft (default da coluna)'
);

-- ═══ Test 0b: assembly_status_check rejeita estado inválido ═════════════
-- 'draft' é aceite (acima); um valor fora do conjunto viola o CHECK.
SELECT throws_ok(
  $$ UPDATE core.assembly SET status='bogus' WHERE id='a_ac' $$,
  '23514',
  NULL,
  'assembly_status_check rejeita estado fora de draft|scheduled|held|cancelled'
);

-- ═══ Test 1: convocation_round bloqueia valores fora do enum ════════════
SELECT throws_ok(
  $$ UPDATE core.assembly SET convocation_round='third' WHERE id='a_ac' $$,
  '23514',
  NULL,
  'CHECK convocation_round rejeita "third"'
);

-- ═══ Test 2: minutes_signed_consistency - signed_at sem president → bloqueia ═══
SELECT throws_ok(
  $$ UPDATE core.assembly SET minutes_signed_at=now() WHERE id='a_ac' $$,
  '23514',
  NULL,
  'CHECK bloqueia minutes_signed_at sem president+secretary (all-or-none)'
);

-- ═══ Test 3: minutes_signed_consistency - president sem signed_at → bloqueia ═══
SELECT throws_ok(
  $$ UPDATE core.assembly SET president_occupant_id='o_ac_p' WHERE id='a_ac' $$,
  '23514',
  NULL,
  'CHECK bloqueia president sem signed_at (all-or-none)'
);

-- ═══ Test 4: minutes_signed all-three together → permitido ════════════════
UPDATE core.assembly
   SET president_occupant_id='o_ac_p',
       secretary_occupant_id='o_ac_s',
       minutes_signed_at=now()
 WHERE id='a_ac';
SELECT ok(
  (SELECT minutes_signed_at FROM core.assembly WHERE id='a_ac') IS NOT NULL,
  'all-three together (president + secretary + signed_at) é aceite'
);

-- Repor para os testes seguintes.
UPDATE core.assembly
   SET president_occupant_id=NULL, secretary_occupant_id=NULL, minutes_signed_at=NULL
 WHERE id='a_ac';

-- ═══ Test 5: FK president inválido → bloqueia ════════════════════════════
SELECT throws_ok(
  $$ UPDATE core.assembly
       SET president_occupant_id='no_existe', secretary_occupant_id='o_ac_s', minutes_signed_at=now()
     WHERE id='a_ac' $$,
  '23503',
  NULL,
  'FK assembly_president_fk rejeita id inexistente'
);

-- ═══ Test 6: attendee_proxy_consistency - is_proxy=true sem portador → bloqueia ═══
SELECT throws_ok(
  $$ INSERT INTO core.assembly_attendee
       (assembly_id, unit_id, occupant_id, permillage_at_meeting, is_proxy)
     VALUES ('a_ac', 'u_ac_a', 'o_ac_p', 500, true) $$,
  '23514',
  NULL,
  'CHECK rejeita is_proxy=true sem proxy_holder_occupant_id nem proxy_holder_external_name'
);

-- ═══ Test 7: is_proxy=false COM proxy_holder → bloqueia ══════════════════
SELECT throws_ok(
  $$ INSERT INTO core.assembly_attendee
       (assembly_id, unit_id, occupant_id, permillage_at_meeting, is_proxy, proxy_holder_occupant_id)
     VALUES ('a_ac', 'u_ac_a', 'o_ac_p', 500, false, 'o_ac_r') $$,
  '23514',
  NULL,
  'CHECK rejeita is_proxy=false COM proxy_holder_occupant_id'
);

-- ═══ Test 8: attendee.permillage <= 0 → bloqueia ═════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.assembly_attendee
       (assembly_id, unit_id, occupant_id, permillage_at_meeting, is_proxy)
     VALUES ('a_ac', 'u_ac_a', 'o_ac_p', 0, false) $$,
  '23514',
  NULL,
  'CHECK rejeita permillage_at_meeting <= 0'
);

-- ═══ Test 9: attendee insert válido (presença em causa própria) ══════════
INSERT INTO core.assembly_attendee
  (id, assembly_id, unit_id, occupant_id, permillage_at_meeting, is_proxy)
VALUES ('att1', 'a_ac', 'u_ac_a', 'o_ac_p', 500, false);
SELECT ok(true, 'attendee em causa própria (is_proxy=false) aceite');

-- ═══ Test 10: attendee insert procuração válida (portador interno) ═══════
INSERT INTO core.assembly_attendee
  (id, assembly_id, unit_id, occupant_id, permillage_at_meeting, is_proxy, proxy_holder_occupant_id)
VALUES ('att2', 'a_ac', 'u_ac_b', 'o_ac_p', 500, true, 'o_ac_r');
SELECT ok(true, 'attendee procuração (is_proxy=true + proxy_holder_occupant_id) aceite');

-- ═══ Test 11: UNIQUE (assembly_id, unit_id) - duplicado bloqueado ═══════
SELECT throws_ok(
  $$ INSERT INTO core.assembly_attendee
       (assembly_id, unit_id, occupant_id, permillage_at_meeting, is_proxy)
     VALUES ('a_ac', 'u_ac_a', 'o_ac_s', 500, false) $$,
  '23505',
  NULL,
  'UNIQUE (assembly_id, unit_id) bloqueia duplicação'
);

-- ═══ Test 12: UNIQUE WHERE NOT deleted - permite recriar após soft-delete ═══
UPDATE core.assembly_attendee SET deleted_at=now() WHERE id='att1';
INSERT INTO core.assembly_attendee
  (id, assembly_id, unit_id, occupant_id, permillage_at_meeting, is_proxy)
VALUES ('att1b', 'a_ac', 'u_ac_a', 'o_ac_p', 500, false);
SELECT ok(true, 'depois de soft-delete, novo attendee para mesma unit é aceite');

-- ═══ Test 13: vote_value_check ═══════════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.assembly_vote
       (assembly_agenda_item_id, unit_id, vote, permillage_applied)
     VALUES ('d_ac', 'u_ac_a', 'maybe', 500) $$,
  '23514',
  NULL,
  'CHECK vote rejeita valor fora de favor|against|abstain'
);

-- ═══ Test 14: vote permillage_applied <= 0 ══════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.assembly_vote
       (assembly_agenda_item_id, unit_id, vote, permillage_applied)
     VALUES ('d_ac', 'u_ac_a', 'favor', -1) $$,
  '23514',
  NULL,
  'CHECK rejeita permillage_applied <= 0'
);

-- ═══ Test 15: vote UNIQUE (decision, unit) ══════════════════════════════
INSERT INTO core.assembly_vote
  (id, assembly_agenda_item_id, unit_id, vote, permillage_applied)
VALUES ('vot1', 'd_ac', 'u_ac_a', 'favor', 500);

SELECT throws_ok(
  $$ INSERT INTO core.assembly_vote
       (assembly_agenda_item_id, unit_id, vote, permillage_applied)
     VALUES ('d_ac', 'u_ac_a', 'against', 500) $$,
  '23505',
  NULL,
  'UNIQUE (decision_id, unit_id) bloqueia 2º voto da mesma unit'
);

SELECT * FROM finish();
ROLLBACK;
