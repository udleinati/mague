-- 0027_normalize_payable_charge_type.sql
--
-- Valida o script `deploy/data/normalize_payable_charge_type.sql`:
--   1. Converte payable+expense+supplier → supplier_service.
--   2. Deixa intacto payable+expense sem fornecedor (custos internos legítimos).
--   3. Deixa intacto qualquer charge que não seja payable (receivable, etc.).
--   4. É idempotente - correr 2× é no-op.
--
-- O script de produção usa BEGIN/COMMIT + cap defensivo (aborta >500). Aqui
-- executamos o mesmo UPDATE sem a transacção/cap, para permitir reproduzir
-- o efeito dentro deste teste (que já está em BEGIN/ROLLBACK seu).

BEGIN;
SELECT plan(7);

-- ═══ Setup ═══════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_nrm', 'Normalize test');
INSERT INTO core.unit (id, condominium_id, designation, permillage, is_active)
  VALUES ('u_nrm', 'cd_nrm', 'A', 1000, true);
INSERT INTO core.supplier (id, condominium_id, name, is_active)
  VALUES ('sup_nrm', 'cd_nrm', 'EDP', true);

-- 1. Payable com supplier - DEVE ser convertido.
INSERT INTO finance.charge (id, condominium_id, kind, nature, charge_type, status,
    scope, issue_date, competence_period, original_amount, expected_amount, open_amount,
    description, supplier_id)
VALUES ('ch_with_sup', 'cd_nrm', 'payable', 'debit', 'expense', 'open',
        'condominium', '2099-01-10', '2099-01-01', 10000, 10000, 10000,
        'Electricidade 01/2099', 'sup_nrm');

-- 2. Payable SEM supplier - DEVE ficar intacto (custo interno, ex: IMI).
INSERT INTO finance.charge (id, condominium_id, kind, nature, charge_type, status,
    scope, issue_date, competence_period, original_amount, expected_amount, open_amount,
    description)
VALUES ('ch_no_sup', 'cd_nrm', 'payable', 'debit', 'expense', 'open',
        'condominium', '2099-02-10', '2099-02-01', 5000, 5000, 5000,
        'IMI (autarquia - sem supplier no sistema)');

-- 3. Receivable com charge_type expense (edge case inexistente mas seguro) -
--    NÃO deve ser tocado.
INSERT INTO finance.charge (id, condominium_id, unit_id, kind, nature, charge_type, status,
    scope, issue_date, competence_period, original_amount, expected_amount, open_amount,
    description)
VALUES ('ch_recv', 'cd_nrm', 'u_nrm', 'receivable', 'debit', 'expense', 'open',
        'unit', '2099-03-10', '2099-03-01', 1000, 1000, 1000, 'Algo receivable');

-- 4. Payable já como supplier_service - idempotência: depois do UPDATE
--    continua supplier_service (não é re-tocado).
INSERT INTO finance.charge (id, condominium_id, kind, nature, charge_type, status,
    scope, issue_date, competence_period, original_amount, expected_amount, open_amount,
    description, supplier_id)
VALUES ('ch_already_ss', 'cd_nrm', 'payable', 'debit', 'supplier_service', 'open',
        'condominium', '2099-04-10', '2099-04-01', 8000, 8000, 8000,
        'EDP já supplier_service', 'sup_nrm');

-- ═══ Executa a mesma lógica do script de produção ═══════════════════════
-- finance.charge não tem deleted_at (cancel via status). Aqui
-- usamos status <> 'cancelled' em vez do antigo filtro deleted_at IS NULL.
UPDATE finance.charge
   SET charge_type = 'supplier_service'
 WHERE kind = 'payable'
   AND charge_type = 'expense'
   AND supplier_id IS NOT NULL
   AND status <> 'cancelled';

-- ═══ Asserts ═════════════════════════════════════════════════════════════
SELECT is((SELECT charge_type FROM finance.charge WHERE id='ch_with_sup'), 'supplier_service',
  'Payable+expense+supplier convertida → supplier_service');

SELECT is((SELECT charge_type FROM finance.charge WHERE id='ch_no_sup'), 'expense',
  'Payable+expense SEM supplier mantém expense (custo interno)');

SELECT is((SELECT charge_type FROM finance.charge WHERE id='ch_recv'), 'expense',
  'Receivable+expense NÃO é tocado (escopo do script é só payable)');

SELECT is((SELECT charge_type FROM finance.charge WHERE id='ch_already_ss'), 'supplier_service',
  'Payable já supplier_service mantém-se (não é re-tocado)');

-- ═══ Idempotência: correr de novo não muda nada ═════════════════════════
UPDATE finance.charge
   SET charge_type = 'supplier_service'
 WHERE kind = 'payable'
   AND charge_type = 'expense'
   AND supplier_id IS NOT NULL
   AND status <> 'cancelled';

SELECT is(
  (SELECT COUNT(*)::int FROM finance.charge
     WHERE condominium_id='cd_nrm' AND charge_type = 'supplier_service'),
  2,
  'Idempotência: segunda corrida mantém 2 charges supplier_service (nada regrediu)');

SELECT is(
  (SELECT COUNT(*)::int FROM finance.charge
     WHERE condominium_id='cd_nrm' AND kind='payable' AND charge_type = 'expense'),
  1,
  'Idempotência: 1 charge expense legítima (sem supplier) mantida intacta');

-- ═══ Ledger não regrediu: o UPDATE só altera charge_type (não há trigger
--     reactivo a esse campo em isolado; apenas `fn_charge_bu` actualiza
--     updated_at e valida cancelados). Confirma que o ledger não ganhou
--     entries duplicados. ══════════════════════════════════════════════
SELECT is(
  (SELECT COUNT(*)::int FROM finance.ledger
     WHERE condominium_id='cd_nrm'),
  -- 3 payables + 1 receivable = 4 inserts de charge × 2 linhas cada (Dr/Cr)
  -- = 8 entries de ledger. Se o UPDATE fizesse algum trigger regredir,
  -- o número mudaria.
  8,
  'Ledger entries intactos após dois UPDATEs consecutivos');

SELECT * FROM finish();
ROLLBACK;
