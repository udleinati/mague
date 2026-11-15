-- 008_trg_refacturation.sql
-- Valida integridade de refaturação (DE8):
--   Quando charge.charge_type='refacturation':
--     - source_type='refacturation' (obrigatório)
--     - source_id aponta para charge existente kind='payable'
--     - Mesma account_id (categoria) da charge referenciada
--     - Mesmo condominium_id

CREATE OR REPLACE FUNCTION core.fn_refacturation_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_source    finance.charge%ROWTYPE;
BEGIN
    IF NEW.charge_type != 'refacturation' THEN RETURN NEW; END IF;

    IF NEW.source_type IS NULL OR NEW.source_type != 'refacturation' THEN
        RAISE EXCEPTION 'Refaturação requer source_type=''refacturation'' (got: %)', NEW.source_type;
    END IF;

    IF NEW.source_id IS NULL THEN
        RAISE EXCEPTION 'Refaturação requer source_id apontando para a despesa original';
    END IF;

    SELECT * INTO v_source FROM finance.charge WHERE id = NEW.source_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'source_id % não encontrada', NEW.source_id;
    END IF;

    IF v_source.kind != 'payable' THEN
        RAISE EXCEPTION 'Refaturação deve apontar para charge kind=''payable'' (got: %)', v_source.kind;
    END IF;

    IF v_source.condominium_id != NEW.condominium_id THEN
        RAISE EXCEPTION 'Refaturação e despesa original devem ter o mesmo condominium_id';
    END IF;

    IF v_source.account_id IS DISTINCT FROM NEW.account_id THEN
        RAISE EXCEPTION 'Refaturação deve ter mesma account_id (categoria) da despesa original: % vs %',
            NEW.account_id, v_source.account_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_refacturation_validate ON finance.charge;
CREATE TRIGGER trg_refacturation_validate
    BEFORE INSERT ON finance.charge
    FOR EACH ROW EXECUTE FUNCTION core.fn_refacturation_validate();
