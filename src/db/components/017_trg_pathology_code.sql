-- 017_trg_pathology_code.sql
--
-- BEFORE INSERT trigger em `core.pathology` que atribui `code` humano
-- automaticamente:
--   • code = 'P' + 3 dígitos base-36 (P001..PZZZ = 46 655 por condomínio).
--     Acima disso o `lpad` de `fn_format_base36` trunca e o código colide.
--
-- Sequência per-condomínio via `core.pathology_code_counter`. UPSERT atómico
-- evita race conditions (row lock no DO UPDATE). Pattern ADR 0023.
--
-- Idempotente: se `NEW.code` já está preenchido (caller TS override raro),
-- respeita e não sobrepõe.

DROP TRIGGER IF EXISTS trg_pathology_code_assign ON core.pathology;
DROP FUNCTION IF EXISTS core.fn_pathology_assign_code();

CREATE OR REPLACE FUNCTION core.fn_pathology_assign_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_n integer;
BEGIN
  IF NEW.code IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Atomicamente incrementa counter (UPSERT com row lock no DO UPDATE).
  INSERT INTO core.pathology_code_counter (condominium_id, last_number, updated_at)
  VALUES (NEW.condominium_id, 1, now())
  ON CONFLICT (condominium_id)
  DO UPDATE SET
    last_number = core.pathology_code_counter.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_n;

  -- Format: P + 3 dígitos base-36 (min_width=3; o `lpad` trunca acima de PZZZ).
  NEW.code := core.fn_format_base36(v_n, 'P', 3);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pathology_code_assign
  BEFORE INSERT ON core.pathology
  FOR EACH ROW
  EXECUTE FUNCTION core.fn_pathology_assign_code();
