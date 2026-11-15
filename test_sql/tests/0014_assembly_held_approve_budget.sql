-- 0014_assembly_held_approve_budget.sql
-- Trigger `trg_assembly_held_approve_budgets`: quando uma
-- assembleia transita scheduled → held, orçamentos referidos por deliberações
-- `approve_budget` com `approved=true` passam a `approved`. Validações do
-- trigger: budget existe, tem linhas, principal único por ano.
BEGIN;
SELECT plan(8);

-- ═══ Setup ═══════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_ah', 'Assembly Held Test');
INSERT INTO core.unit (id, condominium_id, designation, permillage, is_active)
  VALUES ('u_ah', 'cd_ah', 'A', 1000, true);

INSERT INTO finance.chart_of_account (id, code, condominium_id, name, type, parent_code)
  VALUES ('acc_ah', '62299', 'cd_ah', 'Manut teste', 'expense', '6226');

-- Budget com linha (elegível para aprovação)
INSERT INTO core.budget (id, condominium_id, year, status, type, fcr_percentage)
  VALUES ('bd_ah_ok', 'cd_ah', 2099, 'draft', 'principal', 10);
INSERT INTO core.budget_line (id, budget_id, account_id, annual_amount)
  VALUES ('bl_ah_ok', 'bd_ah_ok', 'acc_ah', 120000);

-- Budget SEM linha (deve falhar a aprovação)
INSERT INTO core.budget (id, condominium_id, year, status, type, fcr_percentage)
  VALUES ('bd_ah_bad', 'cd_ah', 2098, 'draft', 'principal', 10);

-- ═══ Caso 1: assembleia com deliberação approve_budget válida ═════════════════
INSERT INTO core.assembly (id, condominium_id, type, scheduled_at, status)
  VALUES ('as_ah_ok', 'cd_ah', 'ordinary', '2099-02-15 19:00+00', 'scheduled');

INSERT INTO core.assembly_agenda_item
  (id, assembly_id, sequence, subject, item_type, ref_type, ref_id, approved)
VALUES
  ('ad_ah_ok', 'as_ah_ok', 1, 'Aprovar orçamento', 'approve_budget', 'budget', 'bd_ah_ok', true);

-- Pré-condição: budget ainda em draft antes do held
SELECT is((SELECT status FROM core.budget WHERE id = 'bd_ah_ok'), 'draft',
  'Budget permanece draft antes de marcar held');

-- Mark held → dispara trigger
UPDATE core.assembly SET status = 'held', held_at = now() WHERE id = 'as_ah_ok';

SELECT is((SELECT status FROM core.budget WHERE id = 'bd_ah_ok'), 'approved',
  'Budget transita para approved após mark held');

SELECT isnt((SELECT approved_at FROM core.budget WHERE id = 'bd_ah_ok'), NULL,
  'approved_at preenchido com now()');

-- ═══ Caso 2: idempotência - marcar held de outra assembleia que aprova o mesmo
-- budget já aprovado deve ser no-op (não falha).
INSERT INTO core.assembly (id, condominium_id, type, scheduled_at, status)
  VALUES ('as_ah_idem', 'cd_ah', 'ordinary', '2099-03-15 19:00+00', 'scheduled');
INSERT INTO core.assembly_agenda_item
  (id, assembly_id, sequence, subject, item_type, ref_type, ref_id, approved)
VALUES ('ad_ah_idem', 'as_ah_idem', 1, 'Re-aprovação', 'approve_budget', 'budget', 'bd_ah_ok', true);

-- Não deve falhar
UPDATE core.assembly SET status = 'held', held_at = now() WHERE id = 'as_ah_idem';

SELECT is((SELECT status FROM core.assembly WHERE id = 'as_ah_idem'), 'held',
  'Held idempotente para budget já aprovado - assembleia fica held');

-- ═══ Caso 3: budget sem linhas → trigger levanta exceção no held ═════════════
INSERT INTO core.assembly (id, condominium_id, type, scheduled_at, status)
  VALUES ('as_ah_bad', 'cd_ah', 'ordinary', '2099-04-15 19:00+00', 'scheduled');
INSERT INTO core.assembly_agenda_item
  (id, assembly_id, sequence, subject, item_type, ref_type, ref_id, approved)
VALUES ('ad_ah_bad', 'as_ah_bad', 1, 'Aprovar vazio', 'approve_budget', 'budget', 'bd_ah_bad', true);

SELECT throws_ok($$
  UPDATE core.assembly SET status = 'held', held_at = now() WHERE id = 'as_ah_bad';
$$,
  NULL,  -- qualquer código de erro (é RAISE EXCEPTION plain)
  NULL,
  'Mark held com budget sem linhas levanta exceção');

-- A assembleia fica com status=scheduled (UPDATE revertido por erro).
SELECT is((SELECT status FROM core.assembly WHERE id = 'as_ah_bad'), 'scheduled',
  'UPDATE revertido: assembleia mantém scheduled');

-- ═══ Caso 4: deliberação com approved=false não aprova o budget ══════════════
INSERT INTO core.budget (id, condominium_id, year, status, type, fcr_percentage)
  VALUES ('bd_ah_rej', 'cd_ah', 2097, 'draft', 'principal', 10);
INSERT INTO core.budget_line (id, budget_id, account_id, annual_amount)
  VALUES ('bl_ah_rej', 'bd_ah_rej', 'acc_ah', 50000);
INSERT INTO core.assembly (id, condominium_id, type, scheduled_at, status)
  VALUES ('as_ah_rej', 'cd_ah', 'ordinary', '2099-05-15 19:00+00', 'scheduled');
INSERT INTO core.assembly_agenda_item
  (id, assembly_id, sequence, subject, item_type, ref_type, ref_id, approved)
VALUES ('ad_ah_rej', 'as_ah_rej', 1, 'Rejeitar', 'approve_budget', 'budget', 'bd_ah_rej', false);

UPDATE core.assembly SET status = 'held', held_at = now() WHERE id = 'as_ah_rej';

SELECT is((SELECT status FROM core.budget WHERE id = 'bd_ah_rej'), 'draft',
  'Budget fica draft quando approved=false');

-- ═══ Caso 5: deliberação de outro tipo (info) ignorada pelo trigger ══════════
INSERT INTO core.budget (id, condominium_id, year, status, type, fcr_percentage)
  VALUES ('bd_ah_info', 'cd_ah', 2096, 'draft', 'principal', 10);
INSERT INTO core.budget_line (id, budget_id, account_id, annual_amount)
  VALUES ('bl_ah_info', 'bd_ah_info', 'acc_ah', 50000);
INSERT INTO core.assembly (id, condominium_id, type, scheduled_at, status)
  VALUES ('as_ah_info', 'cd_ah', 'ordinary', '2099-06-15 19:00+00', 'scheduled');
INSERT INTO core.assembly_agenda_item
  (id, assembly_id, sequence, subject, item_type, approved)
VALUES ('ad_ah_info', 'as_ah_info', 1, 'Outros assuntos', 'info', NULL);

UPDATE core.assembly SET status = 'held', held_at = now() WHERE id = 'as_ah_info';

SELECT is((SELECT status FROM core.budget WHERE id = 'bd_ah_info'), 'draft',
  'Deliberação info não afeta orçamentos (item_type != approve_budget)');

SELECT * FROM finish();
ROLLBACK;
