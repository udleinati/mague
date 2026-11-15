-- 0067_tenant_guard.sql
--
-- Trigger BEFORE INSERT/UPDATE `core.fn_tenant_guard` (component 020): uma linha não
-- aponta para uma entidade de outro condomínio. A API valida antes; isto é a última
-- barreira para um bug futuro, que de outra forma misturava contas (o ledger não se
-- apaga, só se corrige com lançamentos de acerto).
--
-- Cobre:
--   1. Ligação fração/ocupante de condomínios diferentes (tabela sem condominium_id).
--   2. Cobrança com fração ou conta privada de outro condomínio; conta global aceite.
--   3. Liquidação com cobrança de outro condomínio.
--   4. Referência polimórfica (charge.source_type, attachment.entity_type).
--   5. Voto: o condomínio vem do ponto da ordem do dia, via assembleia.
--   6. Linha de orçamento com conta privada de outro condomínio; global aceite.
--   7. UPDATE que não mexe em referências passa numa linha antiga; mudar a referência não.

BEGIN;
SELECT plan(15);

-- ═══ Setup ════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_tg_a', 'Tenant A'), ('cd_tg_b', 'Tenant B');
INSERT INTO core.unit (id, condominium_id, designation, permillage)
  VALUES ('u_tg_a', 'cd_tg_a', 'A1', 1000), ('u_tg_b', 'cd_tg_b', 'B1', 1000);
INSERT INTO core.occupant (id, condominium_id, name)
  VALUES ('o_tg_a', 'cd_tg_a', 'Ana'), ('o_tg_b', 'cd_tg_b', 'Bruno'),
         ('o_tg_b2', 'cd_tg_b', 'Beatriz');
INSERT INTO finance.chart_of_account (id, code, condominium_id, name, type, parent_code)
  VALUES ('acc_tg_b', '62298', 'cd_tg_b', 'Privada B', 'expense', '6226');
INSERT INTO core.budget (id, condominium_id, year, status, type, fcr_percentage)
  VALUES ('bd_tg_a', 'cd_tg_a', 2099, 'draft', 'principal', 10),
         ('bd_tg_b', 'cd_tg_b', 2099, 'draft', 'principal', 10);
INSERT INTO finance.bank_account (
  id, condominium_id, bank_name, account_name, iban, kind,
  opening_balance, opening_balance_ordinary_cents, opening_balance_fcr_cents, opening_balance_date
) VALUES ('ba_tg_a', 'cd_tg_a', 'Banco', 'A', 'PT50TGA', 'bank', 0, 0, 0, '2026-01-01');
INSERT INTO finance.bank_transaction (
  id, condominium_id, bank_account_id, transaction_date, amount, description, status
) VALUES ('bt_tg_a', 'cd_tg_a', 'ba_tg_a', '2026-01-20', 1000, 'TRF', 'unreconciled');
INSERT INTO finance.charge (
  id, condominium_id, unit_id, scope, kind, nature, charge_type, description,
  issue_date, competence_period, original_amount, expected_amount, open_amount, amount
) VALUES ('ch_tg_b', 'cd_tg_b', 'u_tg_b', 'unit', 'receivable', 'debit', 'quota', 'Quota B',
          '2026-01-01', '2026-01-01', 1000, 1000, 1000, 0);
INSERT INTO core.assembly (id, condominium_id, type, scheduled_at)
  VALUES ('asm_tg_a', 'cd_tg_a', 'ordinary', '2099-03-15 19:00:00+00');
INSERT INTO core.assembly_agenda_item (id, assembly_id, sequence, subject)
  VALUES ('ai_tg_a', 'asm_tg_a', 1, 'Obras');

-- ═══ 1. Fração e ocupante ═════════════════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.unit_occupant (unit_id, occupant_id, relationship_type, start_date)
     VALUES ('u_tg_a', 'o_tg_b', 'owner', '2025-01-01') $$,
  '23514', NULL,
  'ocupante de B não se liga a fração de A'
);
SELECT lives_ok(
  $$ INSERT INTO core.unit_occupant (unit_id, occupant_id, relationship_type, start_date)
     VALUES ('u_tg_a', 'o_tg_a', 'owner', '2025-01-01') $$,
  'controlo: ocupante e fração do mesmo condomínio'
);

-- ═══ 2. Cobrança ══════════════════════════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO finance.charge (condominium_id, unit_id, scope, kind, nature, charge_type,
       description, issue_date, competence_period, original_amount, expected_amount, open_amount, amount)
     VALUES ('cd_tg_a', 'u_tg_b', 'unit', 'receivable', 'debit', 'quota', 'x',
       '2026-01-01', '2026-01-01', 100, 100, 100, 0) $$,
  '23514', NULL,
  'cobrança de A com fração de B'
);
SELECT throws_ok(
  $$ INSERT INTO finance.charge (condominium_id, account_id, scope, kind, nature, charge_type,
       description, issue_date, competence_period, original_amount, expected_amount, open_amount, amount)
     VALUES ('cd_tg_a', 'acc_tg_b', 'condominium', 'payable', 'debit', 'expense', 'x',
       '2026-01-01', '2026-01-01', 100, 100, 100, 0) $$,
  '23514', NULL,
  'despesa de A com conta privada de B'
);
SELECT lives_ok(
  format($$ INSERT INTO finance.charge (condominium_id, account_id, scope, kind, nature, charge_type,
       description, issue_date, competence_period, original_amount, expected_amount, open_amount, amount)
     VALUES ('cd_tg_a', %L, 'condominium', 'payable', 'debit', 'expense', 'x',
       '2026-01-01', '2026-01-01', 100, 100, 100, 0) $$,
    (SELECT id FROM finance.chart_of_account WHERE condominium_id IS NULL AND type = 'expense' LIMIT 1)),
  'controlo: conta global aceite em qualquer condomínio'
);

-- ═══ 3. Liquidação ════════════════════════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO finance.settlement (settlement_type, condominium_id, bank_transaction_id,
       debit_charge_id, debit_ref_type, debit_ref_id, amount, settlement_date, status)
     VALUES ('bank_reconciliation', 'cd_tg_a', 'bt_tg_a', 'ch_tg_b', 'charge', 'ch_tg_b',
       100, '2026-01-20', 'active') $$,
  '23514', NULL,
  'movimento de A não liquida cobrança de B'
);

-- ═══ 4. Referências polimórficas ══════════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO finance.charge (condominium_id, unit_id, scope, kind, nature, charge_type,
       description, issue_date, competence_period, original_amount, expected_amount, open_amount, amount,
       source_type, source_id)
     VALUES ('cd_tg_a', 'u_tg_a', 'unit', 'receivable', 'debit', 'quota', 'x',
       '2026-01-01', '2026-01-01', 100, 100, 100, 0, 'budget', 'bd_tg_b') $$,
  '23514', NULL,
  'quota de A gerada a partir do orçamento de B'
);
SELECT throws_ok(
  $$ INSERT INTO core.attachment (condominium_id, entity_type, entity_id, filename, mime_type,
       storage_key, file_size, created_by)
     VALUES ('cd_tg_a', 'charge', 'ch_tg_b', 'f.pdf', 'application/pdf',
       'cd_tg_a/charges/x/f.pdf', 10, '{}'::jsonb) $$,
  '23514', NULL,
  'anexo de A pendurado numa cobrança de B'
);
SELECT lives_ok(
  $$ INSERT INTO core.attachment (condominium_id, entity_type, entity_id, filename, mime_type,
       storage_key, file_size, created_by)
     VALUES ('cd_tg_b', 'charge', 'ch_tg_b', 'f.pdf', 'application/pdf',
       'cd_tg_b/charges/x/f.pdf', 10, '{}'::jsonb) $$,
  'controlo: anexo no próprio condomínio'
);

-- ═══ 5. Voto (condomínio via ordem do dia → assembleia) ═══════════════════
SELECT throws_ok(
  $$ INSERT INTO core.assembly_vote (assembly_agenda_item_id, unit_id, vote, permillage_applied)
     VALUES ('ai_tg_a', 'u_tg_b', 'favor', 1000) $$,
  '23514', NULL,
  'voto na assembleia de A com fração de B'
);
SELECT lives_ok(
  $$ INSERT INTO core.assembly_vote (assembly_agenda_item_id, unit_id, vote, permillage_applied)
     VALUES ('ai_tg_a', 'u_tg_a', 'favor', 1000) $$,
  'controlo: voto com fração do condomínio da assembleia'
);

-- ═══ 6. Linha de orçamento ════════════════════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO core.budget_line (budget_id, account_id, annual_amount)
     VALUES ('bd_tg_a', 'acc_tg_b', 1000) $$,
  '23514', NULL,
  'orçamento de A com conta privada de B'
);
SELECT lives_ok(
  format($$ INSERT INTO core.budget_line (budget_id, account_id, annual_amount)
     VALUES ('bd_tg_a', %L, 1000) $$,
    (SELECT id FROM finance.chart_of_account WHERE condominium_id IS NULL AND type = 'expense' LIMIT 1)),
  'controlo: orçamento com conta global'
);

-- ═══ 7. Linha antiga (gravada antes do guard) ═════════════════════════════
ALTER TABLE core.unit_occupant DISABLE TRIGGER trg_tenant_guard;
INSERT INTO core.unit_occupant (id, unit_id, occupant_id, relationship_type, start_date)
  VALUES ('uo_tg_legacy', 'u_tg_a', 'o_tg_b', 'owner', '2025-01-01');
ALTER TABLE core.unit_occupant ENABLE TRIGGER trg_tenant_guard;

SELECT lives_ok(
  $$ UPDATE core.unit_occupant SET end_date = '2026-01-01' WHERE id = 'uo_tg_legacy' $$,
  'terminar a ligação antiga continua possível (não mexe em referências)'
);
SELECT throws_ok(
  $$ UPDATE core.unit_occupant SET occupant_id = 'o_tg_b2' WHERE id = 'uo_tg_legacy' $$,
  '23514', NULL,
  'mudar a referência da ligação antiga volta a validar'
);

SELECT * FROM finish();
ROLLBACK;
