-- 002_charge_cancellation_reason.sql
-- 1. Justificação do cancelamento de uma charge (obrigatória na API a partir daqui;
--    charges canceladas antes ficam a NULL).
-- 2. fn_charge_au deixa de anular charges a crédito: fn_charge_ai só lança as
--    charges a débito, por isso um crédito cancelado não tem nada a anular.
--    Mesmo CREATE OR REPLACE do component 004 (ADR 0008).

ALTER TABLE finance.charge ADD COLUMN cancellation_reason text;

COMMENT ON COLUMN finance.charge.cancellation_reason IS 'Justificação do cancelamento, escrita pelo admin. Interna: o portal não a expõe.';

CREATE OR REPLACE FUNCTION finance.fn_charge_au()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_acc_debit  varchar;
    v_acc_credit varchar;
BEGIN
    -- Só as charges a débito lançaram no ledger ao nascer (fn_charge_ai).
    IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' AND OLD.nature = 'debit' THEN
        v_acc_debit  := finance.fn_charge_account(OLD.kind, OLD.nature, OLD.charge_type, OLD.account_id);
        v_acc_credit := finance.fn_counterparty_account(OLD.kind, OLD.charge_type);

        IF v_acc_credit IN ('INHERIT_SOURCE', 'BANK_ONLY', 'unknown') THEN
            v_acc_credit := '7888';
        END IF;

        INSERT INTO finance.ledger
            (condominium_id, unit_id, entry_date, entry_type,
             account_code, direction, amount, description, ref_type, ref_id)
        VALUES
            (NEW.condominium_id, NEW.unit_id, CURRENT_DATE, 'charge_cancelled',
             v_acc_credit, 'debit', OLD.open_amount, 'Anulação: ' || OLD.description,
             'charge', NEW.id),
            (NEW.condominium_id, NEW.unit_id, CURRENT_DATE, 'charge_cancelled',
             v_acc_debit, 'credit', OLD.open_amount, 'Anulação: ' || OLD.description,
             'charge', NEW.id);
    END IF;
    RETURN NEW;
END;
$$;
