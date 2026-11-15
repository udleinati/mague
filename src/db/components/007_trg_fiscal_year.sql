-- 007_trg_fiscal_year.sql
-- Bloqueia INSERT/UPDATE em finance.charge e finance.ledger
-- quando o fiscal_year correspondente tem status='closed'.
--
-- Pequena exceção: o fiscal_year pode ser UPDATE-ed pelo próprio admin
-- (ex: ao encerrar), mas os eventos financeiros ficam congelados.

CREATE OR REPLACE FUNCTION core.fn_block_closed_fiscal_year()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_check_date date;
    v_status     varchar;
BEGIN
    IF TG_TABLE_NAME = 'charge' THEN
        v_check_date := COALESCE(NEW.competence_period, NEW.issue_date, CURRENT_DATE);
    ELSIF TG_TABLE_NAME = 'ledger' THEN
        v_check_date := COALESCE(NEW.entry_date, CURRENT_DATE);
    ELSE
        RETURN NEW;
    END IF;

    SELECT status INTO v_status
      FROM finance.fiscal_year
     WHERE condominium_id = NEW.condominium_id
       AND EXTRACT(YEAR FROM v_check_date) = year;

    IF v_status = 'closed' THEN
        RAISE EXCEPTION 'Não é possível gravar em ano fiscal encerrado (%). Tabela: %',
            EXTRACT(YEAR FROM v_check_date), TG_TABLE_NAME;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_charge_closed ON finance.charge;
CREATE TRIGGER trg_block_charge_closed
    BEFORE INSERT OR UPDATE ON finance.charge
    FOR EACH ROW EXECUTE FUNCTION core.fn_block_closed_fiscal_year();

DROP TRIGGER IF EXISTS trg_block_ledger_closed ON finance.ledger;
CREATE TRIGGER trg_block_ledger_closed
    BEFORE INSERT OR UPDATE ON finance.ledger
    FOR EACH ROW EXECUTE FUNCTION core.fn_block_closed_fiscal_year();
