-- 0066_charge_budget_id.sql
--
-- Etiqueta despesa -> orçamento, a coluna que desempata o
-- relatório de execução por Ata quando a inferência por rubrica + ano é
-- ambígua. Ver ADR 0041.
--
-- Cobre o que a coluna promete ao nível da BD:
--   • NULL é válido (é a via da inferência - a esmagadora maioria das linhas)
--   • FK real: não se etiqueta com um orçamento que não existe
--   • a FK protege o histórico: apagar um orçamento etiquetado é bloqueado
--   • etiquetar NÃO toca no ledger (é metadado de imputação, não dinheiro)

BEGIN;
SELECT plan(5);

INSERT INTO core.condominium (id, name) VALUES ('cd_bgt', 'Budget Tag Test');
INSERT INTO core.unit (id, condominium_id, designation, permillage)
VALUES ('u_bgt', 'cd_bgt', 'A', 1000);

INSERT INTO finance.chart_of_account (id, code, condominium_id, name, type, parent_code)
VALUES ('acc_bgt', '6221', 'cd_bgt', 'Obras', 'expense', '622');

-- `principal` (não `suplementar`): o CHECK budget_type_parent_check exige pai
-- para os suplementares, e o pai não acrescenta nada ao que este teste cobre.
INSERT INTO core.budget (id, condominium_id, year, type, status)
VALUES ('bg_bgt', 'cd_bgt', '2099', 'principal', 'approved');

-- ═══ Test 1: sem etiqueta (NULL) é o estado normal ═══════════════════════════
INSERT INTO finance.charge (id, condominium_id, kind, nature, charge_type, status,
  scope, issue_date, due_date, competence_period,
  original_amount, expected_amount, open_amount, description, account_id)
VALUES ('ch_bgt_null', 'cd_bgt', 'payable', 'debit', 'supplier_service', 'open',
  'condominium', '2099-03-01', '2099-03-31', '2099-03-01',
  50000, 50000, 50000, 'Fatura da obra sem etiqueta', 'acc_bgt');

SELECT is(
  (SELECT budget_id FROM finance.charge WHERE id = 'ch_bgt_null'),
  NULL,
  'budget_id nasce NULL - o relatório infere pela rubrica + ano'
);

-- ═══ Test 2: etiqueta explícita grava ════════════════════════════════════════
INSERT INTO finance.charge (id, condominium_id, kind, nature, charge_type, status,
  scope, issue_date, due_date, competence_period,
  original_amount, expected_amount, open_amount, description, account_id, budget_id)
VALUES ('ch_bgt_tag', 'cd_bgt', 'payable', 'debit', 'supplier_service', 'open',
  'condominium', '2099-03-01', '2099-03-31', '2099-03-01',
  70000, 70000, 70000, 'Fatura da obra etiquetada', 'acc_bgt', 'bg_bgt');

SELECT is(
  (SELECT budget_id FROM finance.charge WHERE id = 'ch_bgt_tag'),
  'bg_bgt',
  'etiqueta explícita fica gravada na charge'
);

-- ═══ Test 3: FK real - orçamento inexistente é rejeitado ═════════════════════
SELECT throws_ok(
  $$ UPDATE finance.charge SET budget_id = 'bg_nao_existe' WHERE id = 'ch_bgt_null' $$,
  '23503',
  NULL,
  'FK rejeita etiqueta a apontar para um orçamento que não existe'
);

-- ═══ Test 4: a FK protege o histórico do relatório ═══════════════════════════
-- Apagar o orçamento deixaria a despesa com uma etiqueta pendurada e a Ata sem
-- o seu lado da execução. O caminho normal é soft-delete (deleted_at).
SELECT throws_ok(
  $$ DELETE FROM core.budget WHERE id = 'bg_bgt' $$,
  '23503',
  NULL,
  'não se apaga um orçamento com despesas etiquetadas (FK RESTRICT)'
);

-- ═══ Test 5: etiquetar não mexe no ledger ════════════════════════════════════
-- A promessa do endpoint dedicado (PATCH /charges/:id/budget): é metadado de
-- imputação, por isso pode etiquetar-se uma despesa JÁ PAGA sem consequências
-- contabilísticas. Se um dia um trigger passar a emitir ledger daqui, parte.
CREATE TEMP TABLE ledger_antes AS
  SELECT count(*) AS n FROM finance.ledger WHERE condominium_id = 'cd_bgt';

UPDATE finance.charge SET budget_id = 'bg_bgt' WHERE id = 'ch_bgt_null';

SELECT is(
  (SELECT count(*) FROM finance.ledger WHERE condominium_id = 'cd_bgt'),
  (SELECT n FROM ledger_antes),
  'etiquetar uma despesa não emite nem apaga linhas de ledger'
);

SELECT * FROM finish();
ROLLBACK;
