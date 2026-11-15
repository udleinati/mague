-- 0038_remaining_gaps.sql
--
-- Cobre:
--
--   X. fn_log_change: validar conteúdo de diff/snapshot/actor para
--      INSERT/UPDATE/DELETE - não só que a row existe em audit.cdc_log,
--      mas o formato exato do diff.
--   Y. fn_charge_account com account_id em payable: o ramo que faz
--      lookup ao chart_of_account.code (preferindo a categoria de gasto,
--      classe 6, sobre o genérico 2211).
--   Z. balance_supplier com cenário composto: 2 facturas (1 paga + 1
--      em aberto) e respectivos somatórios.

BEGIN;
SELECT plan(13);

-- ═══════════════════════════════════════════════════════════════════════════
-- X. fn_log_change - estrutura do diff/snapshot/actor
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_g_x', 'Gap X');
INSERT INTO core.unit (id, condominium_id, designation, permillage, is_active)
  VALUES ('u_g_x', 'cd_g_x', 'A', 1000, true);

-- INSERT charge com created_by preenchido. fn_charge_ai dispara também o
-- audit (são 2 triggers AFTER INSERT).
INSERT INTO finance.charge (id, condominium_id, unit_id, kind, nature, charge_type, status,
    scope, issue_date, due_date, competence_period,
    original_amount, expected_amount, open_amount, description, created_by)
VALUES ('ch_g_x', 'cd_g_x', 'u_g_x', 'receivable', 'debit', 'quota', 'open',
        'unit', '2099-01-01', '2099-01-08', '2099-01-01',
        5000, 5000, 5000, 'Quota X',
        '{"id":"u_creator","email":"creator@x.pt","ip":"1.2.3.4"}'::jsonb);

-- (X.1) action='insert' + snapshot completo + actor extraído de created_by.
SELECT is(
  (SELECT action::text FROM audit.cdc_log
    WHERE table_schema='finance' AND table_name='charge' AND row_id='ch_g_x'
    ORDER BY id DESC LIMIT 1),
  'insert', 'X.1: INSERT regista action=insert');

SELECT is(
  (SELECT (snapshot ->> 'description')::text FROM audit.cdc_log
    WHERE table_schema='finance' AND table_name='charge' AND row_id='ch_g_x'
    ORDER BY id DESC LIMIT 1),
  'Quota X', 'X.2: snapshot do INSERT inclui description');

SELECT is(
  (SELECT (actor ->> 'id')::text FROM audit.cdc_log
    WHERE table_schema='finance' AND table_name='charge' AND row_id='ch_g_x'
    ORDER BY id DESC LIMIT 1),
  'u_creator', 'X.3: actor.id extraído de created_by no INSERT');

-- (X.4) Diff é NULL no INSERT (só populado em UPDATE).
SELECT is(
  (SELECT diff FROM audit.cdc_log
    WHERE table_schema='finance' AND table_name='charge' AND row_id='ch_g_x'
    AND action='insert'
    ORDER BY id DESC LIMIT 1),
  NULL::jsonb, 'X.4: diff é NULL para INSERT (só populado em UPDATE)');

-- UPDATE: muda só a description. Diff deve ter before/after com 1 campo
-- (description) - mais updated_at se o trigger BEFORE UPDATE existir.
UPDATE finance.charge
   SET description='Quota X (renomeada)',
       updated_by='{"id":"u_editor","email":"editor@x.pt","ip":"5.6.7.8"}'::jsonb
 WHERE id='ch_g_x';

-- (X.5) action='update' + actor extraído de updated_by.
SELECT is(
  (SELECT (actor ->> 'id')::text FROM audit.cdc_log
    WHERE table_schema='finance' AND table_name='charge' AND row_id='ch_g_x'
    AND action='update'
    ORDER BY id DESC LIMIT 1),
  'u_editor', 'X.5: actor.id extraído de updated_by no UPDATE');

-- (X.6) diff.after.description = novo valor.
SELECT is(
  (SELECT (diff -> 'after' ->> 'description')::text FROM audit.cdc_log
    WHERE table_schema='finance' AND table_name='charge' AND row_id='ch_g_x'
    AND action='update'
    ORDER BY id DESC LIMIT 1),
  'Quota X (renomeada)', 'X.6: diff.after.description preserva o novo valor');

-- (X.7) diff.before.description = valor antigo.
SELECT is(
  (SELECT (diff -> 'before' ->> 'description')::text FROM audit.cdc_log
    WHERE table_schema='finance' AND table_name='charge' AND row_id='ch_g_x'
    AND action='update'
    ORDER BY id DESC LIMIT 1),
  'Quota X', 'X.7: diff.before.description preserva o valor antigo');

-- (X.8) Diff NÃO inclui campos não modificados (ex: original_amount).
-- Validamos via "after" - se a key existir, é porque mudou. Como original_amount
-- não foi tocado, ?'original_amount' = false.
SELECT ok(
  NOT ((SELECT (diff -> 'after') FROM audit.cdc_log
         WHERE table_schema='finance' AND table_name='charge' AND row_id='ch_g_x'
         AND action='update'
         ORDER BY id DESC LIMIT 1) ? 'original_amount'),
  'X.8: diff só inclui colunas modificadas (original_amount não está)');


-- ═══════════════════════════════════════════════════════════════════════════
-- Y. fn_charge_account com account_id - lookup a chart_of_account.code
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_g_y', 'Gap Y');
INSERT INTO finance.chart_of_account (id, code, condominium_id, name, type, parent_code)
  VALUES ('acc_g_y_a', '62299', 'cd_g_y', 'Limpeza Y', 'expense', '6226');
INSERT INTO finance.chart_of_account (id, code, condominium_id, name, type, parent_code)
  VALUES ('acc_g_y_b', '62450', 'cd_g_y', 'Manutencao Y', 'expense', '624');

-- (Y.1) Payable + account_id existente → devolve o code da categoria.
SELECT is(
  finance.fn_charge_account('payable', 'debit', 'supplier_service', 'acc_g_y_a'),
  '62299', 'Y.1: payable com account_id usa o code do chart_of_account');

-- (Y.2) Outro account_id, outro code.
SELECT is(
  finance.fn_charge_account('payable', 'debit', 'supplier_service', 'acc_g_y_b'),
  '62450', 'Y.2: payable com diferente account_id devolve diferente code');

-- (Y.3) Payable + account_id INEXISTENTE → fallback para 2211.
SELECT is(
  finance.fn_charge_account('payable', 'debit', 'supplier_service', 'acc_que_nao_existe'),
  '2211', 'Y.3: payable com account_id inexistente cai em 2211');


-- ═══════════════════════════════════════════════════════════════════════════
-- Z. balance_supplier com cenário multi-charge
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_g_z', 'Gap Z');
INSERT INTO core.supplier (id, condominium_id, name)
  VALUES ('s_g_z', 'cd_g_z', 'Fornecedor Z');
INSERT INTO finance.bank_account (id, condominium_id, bank_name)
  VALUES ('ba_g_z', 'cd_g_z', 'Banco Z');

-- Factura 1: 100€ totalmente paga (open_amount=0).
INSERT INTO finance.charge (id, condominium_id, supplier_id, kind, nature, charge_type, status,
    scope, issue_date, due_date, competence_period,
    original_amount, expected_amount, open_amount, settled_amount, description)
VALUES ('ch_g_z_paid', 'cd_g_z', 's_g_z', 'payable', 'debit', 'supplier_service', 'paid',
        'condominium', '2099-01-01', '2099-01-30', '2099-01-01',
        10000, 10000, 0, 10000, 'Factura paga');

-- Factura 2: 50€ em aberto.
INSERT INTO finance.charge (id, condominium_id, supplier_id, kind, nature, charge_type, status,
    scope, issue_date, due_date, competence_period,
    original_amount, expected_amount, open_amount, description)
VALUES ('ch_g_z_open', 'cd_g_z', 's_g_z', 'payable', 'debit', 'supplier_service', 'open',
        'condominium', '2099-02-01', '2099-02-28', '2099-02-01',
        5000, 5000, 5000, 'Factura por pagar');

-- Factura 3: 30€ vencida (overdue).
INSERT INTO finance.charge (id, condominium_id, supplier_id, kind, nature, charge_type, status,
    scope, issue_date, due_date, competence_period,
    original_amount, expected_amount, open_amount, description)
VALUES ('ch_g_z_overdue', 'cd_g_z', 's_g_z', 'payable', 'debit', 'supplier_service', 'overdue',
        'condominium', '2020-01-01', '2020-01-30', '2020-01-01',
        3000, 3000, 3000, 'Factura vencida');

-- balance_supplier: payable charges têm nature='debit' (débito da nossa
-- contabilidade), por isso aparecem em total_open_debit/current_open_debit.
-- A view total nas 3 facturas: 50 (abertas) + 30 (vencidas) = 80€; a paga
-- (open_amount=0) NÃO conta porque a soma é sobre open_amount.
SELECT is(
  (SELECT total_open_debit FROM finance.balance_supplier WHERE supplier_id='s_g_z')::int,
  8000, 'Z.1: total_open_debit = 80€ (50 abertas + 30 vencidas; paga não conta)');

SELECT is(
  (SELECT current_open_debit FROM finance.balance_supplier WHERE supplier_id='s_g_z')::int,
  8000,
  'Z.2: current_open_debit também 80€ (somatório nature=debit em payables)');

SELECT * FROM finish();
ROLLBACK;
