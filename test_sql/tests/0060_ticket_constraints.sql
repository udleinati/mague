-- 0060_ticket_constraints.sql
--
-- Atribuicao de codigo e invariantes do ticket (core.ticket, component 018):
--   • trg_ticket_code_assign: code = 'T' + base36, sequencial per-condominio
--   • idempotente: code explicito do caller e respeitado
--   • ticket_category_check / priority_check / status_check: enums
--   • ticket_visibility_check: enum + admin_unit exige unit_id (regra composta)
--
-- Nota: throws_ok apanha a excecao numa subtransacao interna, por isso nao
-- precisa de SAVEPOINT externo.

BEGIN;
SELECT plan(10);

-- ═══ Setup: condominio + unidade (visibility=admin_unit precisa de fracao) ════
INSERT INTO core.condominium (id, name) VALUES ('cd_tkt', 'Ticket Test');
INSERT INTO core.unit (id, condominium_id, designation, permillage)
  VALUES ('un_tkt', 'cd_tkt', 'Fr A', 100);

-- ═══ Test 1: 1.o ticket recebe T001 ═══════════════════════════════════════════
INSERT INTO core.ticket (id, condominium_id, title, category, created_by)
  VALUES ('tk_1', 'cd_tkt', 'Elevador parado', 'elevator', '{"id":"u"}'::jsonb);
SELECT is(
  (SELECT code FROM core.ticket WHERE id='tk_1'),
  'T001',
  'trigger atribui T001 ao primeiro ticket do condominio'
);

-- ═══ Test 2: 2.o ticket incrementa para T002 ══════════════════════════════════
INSERT INTO core.ticket (id, condominium_id, title, category, created_by)
  VALUES ('tk_2', 'cd_tkt', 'Luz hall avariada', 'lighting', '{"id":"u"}'::jsonb);
SELECT is(
  (SELECT code FROM core.ticket WHERE id='tk_2'),
  'T002',
  'sequencia per-condominio incrementa (T002)'
);

-- ═══ Test 3: code explicito do caller e respeitado ════════════════════════════
INSERT INTO core.ticket (id, condominium_id, title, category, created_by, code)
  VALUES ('tk_3', 'cd_tkt', 'Import legado', 'other', '{"id":"u"}'::jsonb, 'TXYZ');
SELECT is(
  (SELECT code FROM core.ticket WHERE id='tk_3'),
  'TXYZ',
  'code explicito nao e sobreposto pelo trigger'
);

-- ═══ Test 4: category fora do enum bloqueada ══════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.ticket (condominium_id, title, category, created_by)
     VALUES ('cd_tkt', 'X', 'bogus', '{"id":"u"}'::jsonb) $$,
  '23514',
  NULL,
  'ticket_category_check rejeita categoria invalida'
);

-- ═══ Test 5: priority fora do enum bloqueada ══════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.ticket (condominium_id, title, category, priority, created_by)
     VALUES ('cd_tkt', 'X', 'other', 'super', '{"id":"u"}'::jsonb) $$,
  '23514',
  NULL,
  'ticket_priority_check rejeita prioridade invalida'
);

-- ═══ Test 6: status fora do enum bloqueado ════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.ticket (condominium_id, title, category, status, created_by)
     VALUES ('cd_tkt', 'X', 'other', 'frozen', '{"id":"u"}'::jsonb) $$,
  '23514',
  NULL,
  'ticket_status_check rejeita status invalido'
);

-- ═══ Test 7: visibility fora do enum bloqueada ════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.ticket (condominium_id, title, category, visibility, created_by)
     VALUES ('cd_tkt', 'X', 'other', 'secret', '{"id":"u"}'::jsonb) $$,
  '23514',
  NULL,
  'ticket_visibility_check rejeita visibilidade invalida'
);

-- ═══ Test 8: admin_unit sem unit_id bloqueado (regra composta) ════════════════
SELECT throws_ok(
  $$ INSERT INTO core.ticket (condominium_id, title, category, visibility, created_by)
     VALUES ('cd_tkt', 'X', 'other', 'admin_unit', '{"id":"u"}'::jsonb) $$,
  '23514',
  NULL,
  'ticket_visibility_check exige unit_id quando visibility=admin_unit'
);

-- ═══ Test 9: admin_unit com unit_id aceite ════════════════════════════════════
SELECT lives_ok(
  $$ INSERT INTO core.ticket (condominium_id, unit_id, title, category, visibility, created_by)
     VALUES ('cd_tkt', 'un_tkt', 'X', 'other', 'admin_unit', '{"id":"u"}'::jsonb) $$,
  'visibility=admin_unit com unit_id e aceite'
);

-- ═══ Test 10: code com formato invalido bloqueado ════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.ticket (condominium_id, title, category, created_by, code)
     VALUES ('cd_tkt', 'X', 'other', '{"id":"u"}'::jsonb, 'A1') $$,
  '23514',
  NULL,
  'ticket_code_format_check rejeita code que nao casa ^T[0-9A-Z]{3,}$'
);

SELECT * FROM finish();
ROLLBACK;
