-- 018_trg_ticket_code.sql
--
-- BEFORE INSERT em `core.ticket` que atribui `code` humano (T001..TZZZ)
-- via UPSERT atómico no counter per-condomínio. Pattern ADR 0023, idêntico
-- ao trigger de pathology (component 017).

DROP TRIGGER IF EXISTS trg_ticket_code_assign ON core.ticket;
DROP FUNCTION IF EXISTS core.fn_ticket_assign_code();

CREATE OR REPLACE FUNCTION core.fn_ticket_assign_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_n integer;
BEGIN
  IF NEW.code IS NOT NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO core.ticket_code_counter (condominium_id, last_number, updated_at)
  VALUES (NEW.condominium_id, 1, now())
  ON CONFLICT (condominium_id)
  DO UPDATE SET
    last_number = core.ticket_code_counter.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_n;

  NEW.code := core.fn_format_base36(v_n, 'T', 3);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ticket_code_assign
  BEFORE INSERT ON core.ticket
  FOR EACH ROW
  EXECUTE FUNCTION core.fn_ticket_assign_code();
