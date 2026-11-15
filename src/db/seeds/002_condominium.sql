-- 002_condominium.sql - Condomínio "Av da Mague, X" + ligação admin

INSERT INTO core.condominium (id, name, address, is_active)
VALUES ('MgX001', 'Av da Mague, X', 'Av da Mague, X', true)
ON CONFLICT (id) DO NOTHING;

-- Liga admin ao condomínio
INSERT INTO core.manager (condominium_id, user_id)
SELECT c.id, u.id
  FROM core.condominium c, core."user" u
 WHERE c.id = 'MgX001'
   AND u.email = 'admin@mague.pt'
ON CONFLICT DO NOTHING;
