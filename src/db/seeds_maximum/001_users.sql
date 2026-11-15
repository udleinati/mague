-- 001_users.sql - super + 3 managers (admin de cada par de condomínios).
-- Password = "test" (alinhado com seeds_minimal e seeds normal para os
-- testes e2e e logins manuais funcionarem em qualquer cenário).
--
-- Pós-ADR 0002: `user.role` simplifica para 'super' | NULL. Acesso de
-- administrador/gestor passa por `core.manager` (ver 003_managers.sql).

INSERT INTO core."user" (id, email, name, role, is_active, password_hash)
VALUES
  ('u_super',     'super@mague.pt',     'Super Admin',         'super', true, crypt('test', gen_salt('bf', 12))),
  ('u_admin',     'admin@mague.pt',     'Administrador Geral', NULL,    true, crypt('test', gen_salt('bf', 12))),
  ('u_max_mgr_1', 'manager1@mague.pt',  'Gestor 1',            NULL,    true, crypt('test', gen_salt('bf', 12))),
  ('u_max_mgr_2', 'manager2@mague.pt',  'Gestor 2',            NULL,    true, crypt('test', gen_salt('bf', 12))),
  ('u_max_mgr_3', 'manager3@mague.pt',  'Gestor 3',            NULL,    true, crypt('test', gen_salt('bf', 12)))
ON CONFLICT (id) DO UPDATE SET
  email = EXCLUDED.email,
  password_hash = EXCLUDED.password_hash,
  is_active = EXCLUDED.is_active,
  role = EXCLUDED.role;
