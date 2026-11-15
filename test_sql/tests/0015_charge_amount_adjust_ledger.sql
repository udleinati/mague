-- 0015_charge_amount_adjust_ledger.sql
-- Trigger `trg_charge_amount_adjust_ledger`:
-- quando `finance.charge.original_amount` é alterado em charges payable/debit
-- não-refacturação, posta 2 entries de delta no ledger (Dr conta despesa + Cr
-- 2211), positivas ou negativas conforme a direção da alteração.
-- Uso real: despesa prevista 100€, factura chega 90€/110€; editar a charge
-- mantém o ledger coerente.
BEGIN;
SELECT plan(9);

-- ═══ Setup ══════════════════════════════════════════════════════════════════
INSERT INTO core.condominium (id, name) VALUES ('cd_cad', 'Charge Adjust Test');

-- Categoria (despesa): precisa existir para o ledger referenciar.
INSERT INTO finance.chart_of_account (id, code, condominium_id, name, type, parent_code)
  VALUES ('acc_cad', '62299', 'cd_cad', 'EDP teste', 'expense', '6226');

-- Charge payable 100€. Ao criar, fn_charge_ai posta:
--   Dr 62299 100€
--   Cr 2211  100€
INSERT INTO finance.charge
  (id, condominium_id, kind, nature, charge_type, status,
   issue_date, competence_period, original_amount, open_amount, amount, description, account_id)
VALUES
  ('ch_cad', 'cd_cad', 'payable', 'debit', 'expense', 'open',
   '2099-01-15', '2099-01-01', 10000, 10000, 0, 'EDP Jan 2099', 'acc_cad');

SELECT is((SELECT COUNT(*)::int FROM finance.ledger WHERE ref_id = 'ch_cad'), 2,
  'Após create, ledger tem 2 entries iniciais');

SELECT is((SELECT SUM(amount)::int FROM finance.ledger
           WHERE ref_id = 'ch_cad' AND direction = 'debit'), 10000,
  'Débitos iniciais somam 10000');

SELECT is((SELECT SUM(amount)::int FROM finance.ledger
           WHERE ref_id = 'ch_cad' AND direction = 'credit'), 10000,
  'Créditos iniciais somam 10000');

-- ═══ Caso 1: reduzir valor (factura chegou 90€ em vez de 100€) ═══════════════
UPDATE finance.charge SET original_amount = 9000, open_amount = 9000 WHERE id = 'ch_cad';

-- O trigger posta delta = -1000 → 2 entries com direções invertidas.
SELECT is((SELECT COUNT(*)::int FROM finance.ledger WHERE ref_id = 'ch_cad'), 4,
  'Após decrease, ledger tem 4 entries (2 iniciais + 2 delta)');

-- Soma líquida (Dr − Cr) por conta tem de refletir o novo valor.
-- Conta 62299 (despesa, Dr natural): inicial 10000 Dr, delta -1000 Dr = 9000 líquido.
SELECT is(
  (SELECT (COALESCE(SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END), 0))::int
     FROM finance.ledger WHERE ref_id = 'ch_cad' AND account_code = '62299'),
  9000,
  'Conta despesa 62299 líquido = 9000 após redução'
);

-- Conta 2211 (fornecedores, Cr natural): inicial 10000 Cr, delta -1000 Cr = 9000 líquido Cr (-9000 se vendo pela Dr).
SELECT is(
  (SELECT (COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END), 0))::int
     FROM finance.ledger WHERE ref_id = 'ch_cad' AND account_code = '2211'),
  9000,
  'Conta fornecedores 2211 líquido (crédito) = 9000 após redução'
);

-- ═══ Caso 2: aumentar valor (factura chegou 110€ em vez de 90€) ══════════════
UPDATE finance.charge SET original_amount = 11000, open_amount = 11000 WHERE id = 'ch_cad';

SELECT is((SELECT COUNT(*)::int FROM finance.ledger WHERE ref_id = 'ch_cad'), 6,
  'Após increase, ledger tem 6 entries (2 iniciais + 2 primeiro delta + 2 segundo delta)');

-- Liquido final na 62299 = 11000 (novo valor)
SELECT is(
  (SELECT (COALESCE(SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END), 0))::int
     FROM finance.ledger WHERE ref_id = 'ch_cad' AND account_code = '62299'),
  11000,
  'Conta despesa líquido = 11000 após aumento'
);

-- ═══ Caso 3: charge de quota (type bloqueado pelo trigger) - NÃO posta delta ═
-- Setup charge de quota para verificar que o trigger NÃO actua.
INSERT INTO core.unit (id, condominium_id, designation, permillage, is_active)
  VALUES ('u_cad', 'cd_cad', 'A', 1000, true);
INSERT INTO finance.charge
  (id, condominium_id, unit_id, scope, kind, nature, charge_type, status,
   issue_date, competence_period, original_amount, open_amount, amount, description)
VALUES
  ('ch_cad_q', 'cd_cad', 'u_cad', 'unit', 'receivable', 'debit', 'quota', 'open',
   '2099-01-15', '2099-01-01', 10000, 10000, 0, 'Quota Jan 2099');

-- Tenta atualizar; o trigger `fn_charge_amount_adjust_ledger` salta cedo
-- porque `kind='payable'` é condição. Ledger não deve ganhar entries novos.
UPDATE finance.charge SET original_amount = 9000, open_amount = 9000 WHERE id = 'ch_cad_q';

-- Só as 3 entries iniciais de quota (Dr 2111, Cr 721, Cr 723 se FCR≠0; aqui
-- FCR=0 por default do account, mas o charge_type=quota vai para 721/723 só
-- se o trigger fn_charge_ai estiver configurado para isso - verificamos que
-- o delta NÃO foi posto: número de entries não aumenta).
SELECT is(
  (SELECT COUNT(*)::int FROM finance.ledger WHERE ref_id = 'ch_cad_q'
    AND entry_type = 'charge_amount_adjusted'),
  0,
  'Charge tipo quota NÃO dispara delta no ledger (apenas payable não-refact)'
);

-- Nota: refacturations também são ignoradas pelo trigger; não testadas aqui
-- por exigirem source_type/source_id válidos (fn_refacturation_validate).

SELECT * FROM finish();
ROLLBACK;
