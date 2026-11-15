-- 003_managers.sql - liga managers aos condomínios.
--
-- Distribuição (para testes cross-manager funcionarem):
--   u_admin     → todos os 5 (admin geral)
--   u_max_mgr_1 → condo_max_1 + condo_max_2
--   u_max_mgr_2 → condo_max_3 + condo_max_4
--   u_max_mgr_3 → condo_max_5
--
-- O super (u_super) NÃO precisa de manager - tem acesso a tudo via role.

INSERT INTO core.manager (id, condominium_id, user_id, is_active)
VALUES
  ('mgr_max_admin_1', 'condo_max_1', 'u_admin', true),
  ('mgr_max_admin_2', 'condo_max_2', 'u_admin', true),
  ('mgr_max_admin_3', 'condo_max_3', 'u_admin', true),
  ('mgr_max_admin_4', 'condo_max_4', 'u_admin', true),
  ('mgr_max_admin_5', 'condo_max_5', 'u_admin', true),
  ('mgr_max_m1_1',    'condo_max_1', 'u_max_mgr_1', true),
  ('mgr_max_m1_2',    'condo_max_2', 'u_max_mgr_1', true),
  ('mgr_max_m2_3',    'condo_max_3', 'u_max_mgr_2', true),
  ('mgr_max_m2_4',    'condo_max_4', 'u_max_mgr_2', true),
  ('mgr_max_m3_5',    'condo_max_5', 'u_max_mgr_3', true)
ON CONFLICT (id) DO NOTHING;
