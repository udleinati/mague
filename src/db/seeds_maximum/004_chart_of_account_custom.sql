-- 004_chart_of_account_custom.sql - 1 conta "expense generic" por condomínio
-- (budget_lines + charges payable). Seed maximum visa volume, não realismo
-- de classes contabilísticas, por isso basta uma genérica.

INSERT INTO finance.chart_of_account (id, condominium_id, code, name, type)
VALUES
  ('coa_max_1', 'condo_max_1', 'cust.geral', 'Despesas Gerais',          'expense'),
  ('coa_max_2', 'condo_max_2', 'cust.geral', 'Despesas Gerais',          'expense'),
  ('coa_max_3', 'condo_max_3', 'cust.geral', 'Despesas Gerais',          'expense'),
  ('coa_max_4', 'condo_max_4', 'cust.geral', 'Despesas Gerais',          'expense'),
  ('coa_max_5', 'condo_max_5', 'cust.geral', 'Despesas Gerais',          'expense')
ON CONFLICT (id) DO NOTHING;
