-- 001_admin.sql - Utilizadores super e admin com password "test"
-- Alinhado com seeds_minimal/001_setup.sql para que login funcione em ambos
-- test:up e test:up:minimal com as mesmas credenciais de referência.
--
-- Pós-ADR 0002: `user.role` simplifica para 'super' | NULL. Acesso de
-- administrador a um condomínio passa por `core.manager` (ver 002_condominium.sql
-- para u_admin → MgX001).

INSERT INTO core."user" (id, email, name, role, is_active, password_hash)
VALUES
  ('u_super', 'super@mague.pt', 'Super Admin',   'super', true, crypt('test', gen_salt('bf', 12))),
  ('u_admin', 'admin@mague.pt', 'Administrador', NULL,    true, crypt('test', gen_salt('bf', 12)))
ON CONFLICT (id) DO UPDATE SET
  email = EXCLUDED.email,
  password_hash = EXCLUDED.password_hash,
  is_active = EXCLUDED.is_active,
  role = EXCLUDED.role;
