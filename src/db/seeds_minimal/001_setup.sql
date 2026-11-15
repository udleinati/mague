-- 001_setup.sql - cenário mínimo para desenvolvimento/testes.
--
-- IDs fixos (para permitir consultas estáveis entre corridas):
--   condomínio:        MgX001
--   frações:          unit_min_a .. unit_min_f
--   chart_of_account:  cat_min_001
--   budgets:           bg_min_principal / bg_min_supl_1 / bg_min_supl_2 / bg_min_2027_draft / bg_min_2027_extra
--   assembleias:       ass_min_ord_2026 / ass_min_ext_2026
--   conta bancária:    ba_min_001
--
-- Estados:
--   • 6 frações A-F (permilagens 100/100/200/200/200/200 = 1000)
--   • 5 budgets: 2 aprovados (2026 principal + suplementar) + 3 por aprovar
--   • 2 assembleias (uma realizada, uma agendada)
--   • 1 conta bancária com 15 movimentos por conciliar (€1-€200)
--   • Charges manuais:
--       A, B → com crédito (2026-01)
--       C, D → com débito em dívida (2025-12 - período anterior para não colidir
--              com o trigger de generate-quotas quando o utilizador o dispara)
--       E, F → zeradas (sem charges)

-- ── Utilizadores (super + manager) ─────────────────────────────────────────
-- password = "test" (hashed via bcrypt - pgcrypto gen_salt('bf', 12))
-- Pós-ADR 0002: `user.role` é 'super' | NULL. Para u_manager o acesso de
-- admin vem do registo em `core.manager` mais abaixo (mgr_min_001).
INSERT INTO core."user" (id, email, name, role, is_active, password_hash)
VALUES
  ('u_super',   'super@mague.pt',   'Super Admin',     'super', true, crypt('test', gen_salt('bf', 12))),
  ('u_manager', 'manager@mague.pt', 'Gestor de Teste', NULL,    true, crypt('test', gen_salt('bf', 12)))
ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role;

-- ── Condomínios (principal + 2 extra para testar troca de contexto) ────────
INSERT INTO core.condominium (id, name, address, is_active)
VALUES
  ('MgX001', 'Rua das Acácias, 12',       'Rua das Acácias, 12',             true),
  ('CondoBeta',  'Rua das Flores, 42',    'Rua das Flores, 42, Lisboa', true),
  ('CondoGama',  'Praça do Comércio, 1',  'Praça do Comércio, 1, Porto', true)
ON CONFLICT (id) DO NOTHING;

-- Manager gere apenas Rua das Acácias (MgX001). O super vê os 3.
INSERT INTO core.manager (id, condominium_id, user_id, is_active)
VALUES ('mgr_min_001', 'MgX001', 'u_manager', true)
ON CONFLICT (id) DO NOTHING;

-- ── 6 Frações (IDs fixos) ──────────────────────────────────────────────────
-- `identifier` é coluna gerada a partir de block+floor+door - basta povoar
-- floor/door (deixa block NULL para ler tipo "Piso 1, Porta Esq").
INSERT INTO core.unit (id, condominium_id, unit_type, designation, permillage, floor, door, is_active)
VALUES
  ('unit_min_a', 'MgX001', 'residential', 'A', 100, '1', 'Esq', true),
  ('unit_min_b', 'MgX001', 'residential', 'B', 100, '1', 'Dto', true),
  ('unit_min_c', 'MgX001', 'residential', 'C', 200, '2', 'Esq', true),
  ('unit_min_d', 'MgX001', 'residential', 'D', 200, '2', 'Dto', true),
  ('unit_min_e', 'MgX001', 'residential', 'E', 200, '3', 'Esq', true),
  ('unit_min_f', 'MgX001', 'residential', 'F', 200, '3', 'Dto', true)
ON CONFLICT (id) DO UPDATE SET floor = EXCLUDED.floor, door = EXCLUDED.door;

-- ── Occupants + unit_occupants ──────────────────────────────────────────────
-- Metade das frações tem occupant com email (A, B, C), metade sem (D, E, F)
-- - útil para testar o alerta de "sem email" e a falha de envio do lembrete.
INSERT INTO core.occupant (id, condominium_id, name, email, receive_receipt_emails)
VALUES
  ('occ_min_a', 'MgX001', 'Owner A', 'owner-a@test.pt', true),
  ('occ_min_b', 'MgX001', 'Owner B', 'owner-b@test.pt', true),
  ('occ_min_c', 'MgX001', 'Owner C', 'owner-c@test.pt', true),
  ('occ_min_d', 'MgX001', 'Owner D', NULL,             false),
  ('occ_min_e', 'MgX001', 'Owner E', NULL,             false),
  ('occ_min_f', 'MgX001', 'Owner F', NULL,             false)
ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;

INSERT INTO core.unit_occupant (id, unit_id, occupant_id, relationship_type, start_date)
VALUES
  ('uo_min_a', 'unit_min_a', 'occ_min_a', 'owner', '2025-01-01'),
  ('uo_min_b', 'unit_min_b', 'occ_min_b', 'owner', '2025-01-01'),
  ('uo_min_c', 'unit_min_c', 'occ_min_c', 'owner', '2025-01-01'),
  ('uo_min_d', 'unit_min_d', 'occ_min_d', 'owner', '2025-01-01'),
  ('uo_min_e', 'unit_min_e', 'occ_min_e', 'owner', '2025-01-01'),
  ('uo_min_f', 'unit_min_f', 'occ_min_f', 'owner', '2025-01-01')
ON CONFLICT (id) DO NOTHING;

-- Co-propriedade: super-admin é co-owner de A e D (testa "mesmo email admin +
-- proprietário"). Unique (condominium_id, user_id) em core.occupant força 1 row
-- occupant por user/condomínio, ligada a N frações via unit_occupant.
INSERT INTO core.occupant (id, condominium_id, user_id, name, email, receive_receipt_emails)
VALUES ('occ_super_a', 'MgX001', 'u_super', 'Super Admin', 'super@mague.pt', true)
ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, email = EXCLUDED.email;
INSERT INTO core.unit_occupant (id, unit_id, occupant_id, relationship_type, start_date)
VALUES
  ('uo_super_a', 'unit_min_a', 'occ_super_a', 'owner', '2025-01-01'),
  ('uo_super_d', 'unit_min_d', 'occ_super_a', 'owner', '2025-01-01')
ON CONFLICT (id) DO NOTHING;

-- ── Chart of account (custom do condomínio) ────────────────────────────────
INSERT INTO finance.chart_of_account (id, condominium_id, code, name, type)
VALUES ('cat_min_001', 'MgX001', 'cust.geral', 'Geral', 'expense')
ON CONFLICT (id) DO NOTHING;

-- ── Budgets ─────────────────────────────────────────────────────────────────
-- 2026: 1 principal aprovado (pai) + 1 suplementar aprovado + 1 suplementar em rascunho
-- 2027: 1 principal em rascunho (sem filhos) - o suplementar 2027 só seria válido após aprovar o pai
INSERT INTO core.budget (id, condominium_id, year, type, status, fcr_percentage, parent_budget_id, approved_at)
VALUES
  ('bg_min_principal',  'MgX001', 2026, 'principal',   'approved', 10, NULL,               NOW()),
  ('bg_min_supl_1',     'MgX001', 2026, 'suplementar', 'approved',  0, 'bg_min_principal', NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.budget (id, condominium_id, year, type, status, fcr_percentage, parent_budget_id)
VALUES
  ('bg_min_supl_2',     'MgX001', 2026, 'suplementar', 'draft', 0, 'bg_min_principal'),
  ('bg_min_2027_draft', 'MgX001', 2027, 'principal',   'draft', 10, NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.budget_line (budget_id, account_id, annual_amount)
VALUES
  ('bg_min_principal',  'cat_min_001', 1200000),  -- 12.000 € → 1.000 €/mês
  ('bg_min_supl_1',     'cat_min_001',  120000),  --  1.200 € →   100 €/mês
  ('bg_min_supl_2',     'cat_min_001',   60000),  --    600 € →    50 €/mês
  ('bg_min_2027_draft', 'cat_min_001', 1500000)   -- 15.000 € (2027 projectado)
ON CONFLICT DO NOTHING;

-- ── Assembleias ─────────────────────────────────────────────────────────────
INSERT INTO core.assembly (id, condominium_id, type, scheduled_at, held_at, location, status, notes)
VALUES
  ('ass_min_ord_2026', 'MgX001', 'ordinary',
   '2026-02-10 19:00:00+00', '2026-02-10 19:30:00+00',
   'Salão do condomínio', 'held',
   'Assembleia ordinária 2026 - aprovação de contas e orçamento'),
  ('ass_min_ext_2026', 'MgX001', 'extraordinary',
   '2026-06-15 19:00:00+00', NULL,
   'Online (Zoom)', 'scheduled',
   'Assembleia extraordinária - obras na cobertura')
ON CONFLICT (id) DO NOTHING;

-- ── Conta bancária + 15 movimentos por conciliar ─────────────────────────
INSERT INTO finance.bank_account (id, condominium_id, bank_name, iban, account_name,
    opening_balance, opening_balance_date, is_active)
VALUES ('ba_min_001', 'MgX001', 'Caixa Geral', 'PT50000700000000123456789',
        'Conta corrente', 0, '2026-01-01', true)
ON CONFLICT (id) DO NOTHING;

-- 15 transferências (€1, €2, …, €15 em valores crescentes × 10 = €10..€150)
INSERT INTO finance.bank_transaction (bank_account_id, condominium_id, transaction_date,
    amount, description, status)
SELECT 'ba_min_001', 'MgX001',
       DATE '2026-01-01' + (n || ' days')::interval,
       n * 1000,
       'Depósito teste ' || n || '0€',
       'unreconciled'
FROM generate_series(1, 15) n;

-- ── Charges para os 3 estados de balance ────────────────────────────────────
-- A → com crédito simples (100 €)
-- B → com 2 créditos (200 € + 50 € = 250 €) para cobrir múltiplas quotas
INSERT INTO finance.charge
  (id, condominium_id, unit_id, scope, nature, charge_type, kind,
   issue_date, competence_period, original_amount, expected_amount, open_amount, description)
VALUES
  ('ch_min_credit_a',  'MgX001', 'unit_min_a', 'unit', 'credit', 'payment', 'receivable',
   '2026-01-15', '2026-01-01', 10000, 10000, 10000, 'Adiantamento (cenário mínimo)'),
  ('ch_min_credit_b1', 'MgX001', 'unit_min_b', 'unit', 'credit', 'payment', 'receivable',
   '2026-01-15', '2026-01-01', 20000, 20000, 20000, 'Adiantamento #1 (cenário mínimo)'),
  ('ch_min_credit_b2', 'MgX001', 'unit_min_b', 'unit', 'credit', 'payment', 'receivable',
   '2026-01-20', '2026-01-01',  5000,  5000,  5000, 'Adiantamento #2 (cenário mínimo)')
ON CONFLICT (id) DO NOTHING;

-- C, D → com débito em dívida de período anterior (2025-12) - evita colisão
-- com o handler runQuotaGeneration quando o utilizador o dispara para 2026
INSERT INTO finance.charge
  (id, condominium_id, unit_id, scope, nature, charge_type, status, kind,
   issue_date, due_date, competence_period, original_amount, expected_amount, open_amount, description)
VALUES
  ('ch_min_debit_c', 'MgX001', 'unit_min_c', 'unit', 'debit', 'quota', 'overdue', 'receivable',
   '2025-12-01', '2025-12-08', '2025-12-01', 10000, 10000, 10000, 'Quota Dezembro/2025 (em dívida)'),
  ('ch_min_debit_d', 'MgX001', 'unit_min_d', 'unit', 'debit', 'quota', 'overdue', 'receivable',
   '2025-12-01', '2025-12-08', '2025-12-01', 10000, 10000, 10000, 'Quota Dezembro/2025 (em dívida)')
ON CONFLICT (id) DO NOTHING;
