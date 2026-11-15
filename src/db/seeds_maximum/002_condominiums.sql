-- 002_condominiums.sql - 5 condomínios com tamanhos variados para testes
-- de carga. Tamanhos: 15, 30, 50, 80, 100 frações (total 275).
--
-- Distribuídos geograficamente para parecer um portfólio real de gestor:
--   condo_max_1 → Lisboa, prédio médio (80 frações)
--   condo_max_2 → Porto, edifício pequeno (15 frações)
--   condo_max_3 → Coimbra, complexo grande (100 frações)
--   condo_max_4 → Faro, prédio standard (30 frações)
--   condo_max_5 → Braga, prédio amplo (50 frações)

INSERT INTO core.condominium (id, name, address, is_active)
VALUES
  ('condo_max_1', 'Edifício Atlântida',  'Av. da República 100, Lisboa',         true),
  ('condo_max_2', 'Vila Pequena',        'Rua de Santa Catarina 45, Porto',      true),
  ('condo_max_3', 'Torres do Saldanha',  'Praça da República 200, Coimbra',      true),
  ('condo_max_4', 'Residencial Estrela', 'Rua Conselheiro Bivar 50, Faro',       true),
  ('condo_max_5', 'Bloco Central',       'Av. da Liberdade 25, Braga',           true)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  address = EXCLUDED.address;
