-- 010_charges_quotas.sql - quotas mensais 2020-2026 para todas as frações.
-- Volume: 275 frações × 12 meses × 7 anos = 23.100 charges receivable. Valor
-- fixo ~100€/unit/mês (em produção seria proporcional à permilagem; aqui
-- simplificado). created_at = issue_date para ordenação cronológica realista.
--
-- Gotchas:
--  - fn_charge_ai emite ledger por charge - 23k charges = gargalo do seed.
--  - expected_amount = original_amount é OBRIGATÓRIO para o trigger de
--    settlement classificar o status.
--  - Status `open`; os settlements marcam paid/partial.

INSERT INTO finance.charge (
  id, condominium_id, unit_id, scope, nature, charge_type, kind, status,
  issue_date, due_date, competence_period,
  original_amount, expected_amount, open_amount,
  description, created_at
)
SELECT
  'ch_max_q_' || u.id || '_' || y || lpad(m::text, 2, '0'),
  u.condominium_id,
  u.id,
  'unit',
  'debit',
  'quota',
  'receivable',
  'open',
  -- Issue: dia 1 de cada mês.
  make_date(y, m, 1),
  -- Due: dia 8 do mesmo mês (como na geração real).
  make_date(y, m, 8),
  -- Competence: dia 1 (sempre).
  make_date(y, m, 1),
  10000,  -- 100€ em cêntimos
  10000,
  10000,
  'Quota ordinária ' || lpad(m::text, 2, '0') || '/' || y,
  -- created_at = issue_date ao 09:00 UTC (ordem realista).
  (make_date(y, m, 1) + INTERVAL '9 hours')::timestamptz
FROM core.unit u
CROSS JOIN generate_series(2020, 2026) AS y
CROSS JOIN generate_series(1, 12) AS m
WHERE u.condominium_id LIKE 'condo_max_%'
ON CONFLICT (id) DO NOTHING;
