-- 010_trg_charge_code.sql
--
-- BEFORE INSERT trigger em `finance.charge` que atribui `code` humano
-- automaticamente:
--   • kind='payable'    → `D` + 4 dígitos base-36 (D0001..DZZZZ)
--   • kind='receivable' → `R` + 5 dígitos base-36 (R00001..RZZZZZ)
-- Largura por prefixo definida em `fn_charge_code_format` (D = 4, R = 5).
-- A CHECK constraint aceita D com 4 dígitos OU R com 5.
--
-- Sequências independentes per (condominium_id, prefix) via
-- `finance.charge_code_counter`. Atómico - row lock no `ON CONFLICT DO UPDATE`.
-- Idempotente: respeita NEW.code já preenchido (backfill, override TS).
-- Em trigger (não TS) porque há 7+ call sites a inserir charges; ADR 0001.

DROP TRIGGER IF EXISTS trg_charge_code_assign ON finance.charge;
DROP FUNCTION IF EXISTS finance.fn_charge_assign_code();

CREATE OR REPLACE FUNCTION finance.fn_charge_assign_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_prefix text;
  v_n integer;
BEGIN
  IF NEW.code IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Kind inválido = erro forte (CHECK na coluna já protege; defesa extra).
  v_prefix := CASE NEW.kind
    WHEN 'payable' THEN 'D'
    WHEN 'receivable' THEN 'R'
    ELSE NULL
  END;

  IF v_prefix IS NULL THEN
    RAISE EXCEPTION 'fn_charge_assign_code: kind "%" inválido (esperado payable|receivable)',
      NEW.kind;
  END IF;

  -- Atomicamente incrementa counter (UPSERT com row lock no DO UPDATE).
  INSERT INTO finance.charge_code_counter (condominium_id, prefix, last_number, updated_at)
  VALUES (NEW.condominium_id, v_prefix, 1, now())
  ON CONFLICT (condominium_id, prefix)
  DO UPDATE SET
    last_number = finance.charge_code_counter.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_n;

  NEW.code := finance.fn_charge_code_format(v_n, v_prefix);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_charge_code_assign
  BEFORE INSERT ON finance.charge
  FOR EACH ROW
  EXECUTE FUNCTION finance.fn_charge_assign_code();
