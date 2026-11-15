-- 004_trg_financial.sql - Triggers do modelo charge/settlement/ledger.
-- Ver ADR 0001. Triggers = única fonte de verdade do ledger (imutável,
-- component 014); state machine + validações + auto-offset vivem em TS
-- (src/apps/api/modules/admin/{settlement,charge}/). Partidas dobradas:
-- cada evento gera 2+ linhas (Σ Dr = Σ Cr).
--
-- Mapa de account_codes (ver seed 000a - padrão SNC):
--   121  - Banco Ordinária        2211 - Fornecedores a Pagar
--   122  - Banco FCR              2782 - Outros Credores
--   2111 - A Receber Ordinárias   2789 - Suspense (Valores a Classificar)
--   2112 - A Receber Extra        581  - Fundo FCR (Reservas legais)
--   2113 - A Receber Refact.      721/722/723 - Quotas/Extra/FCR (revenue)
--                                 7888 - Outras Receitas
--                                 6XXX - Gastos (account_id da charge)

-- ═══════════════════════════════════════════════════════════════════════════════
-- HELPERS PUROS (chamadas read-only, usadas pelos triggers)
-- ═══════════════════════════════════════════════════════════════════════════════

-- (Não há fn_charge_status: a regra do status gravado vive em TS, em
-- settlement/charge_status.ts.)

-- Resolve o account_code "principal" da charge (Dr no charge_created).
CREATE OR REPLACE FUNCTION finance.fn_charge_account(
    p_kind         varchar,
    p_nature       varchar,
    p_charge_type  varchar,
    p_account_id   text DEFAULT NULL
) RETURNS varchar
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_code varchar;
BEGIN
    IF p_charge_type = 'unclassified' THEN RETURN '2789'; END IF;

    IF p_kind = 'receivable' THEN
        IF p_charge_type = 'quota'               THEN RETURN '2111'; END IF;
        IF p_charge_type = 'extraordinary_quota' THEN RETURN '2112'; END IF;
        IF p_charge_type = 'refacturation'       THEN RETURN '2113'; END IF;
        IF p_nature      = 'credit'              THEN RETURN '2782'; END IF;
        RETURN '2111';
    END IF;

    IF p_kind = 'payable' THEN
        IF p_account_id IS NOT NULL THEN
            SELECT code INTO v_code FROM finance.chart_of_account WHERE id = p_account_id;
            IF v_code IS NOT NULL THEN RETURN v_code; END IF;
        END IF;
        RETURN '2211';
    END IF;

    RETURN 'unknown';
END;
$$;

-- Resolve o account_code da contrapartida (Cr no charge_created).
CREATE OR REPLACE FUNCTION finance.fn_counterparty_account(
    p_kind         varchar,
    p_charge_type  varchar
) RETURNS varchar
LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF p_charge_type = 'quota'                 THEN RETURN '721'; END IF;
    IF p_charge_type = 'extraordinary_quota'   THEN RETURN '722'; END IF;
    IF p_charge_type = 'opening_balance_debit' THEN RETURN '59';  END IF;
    IF p_charge_type = 'refacturation'         THEN RETURN 'INHERIT_SOURCE'; END IF;
    IF p_charge_type = 'unclassified'          THEN RETURN 'BANK_ONLY'; END IF;
    IF p_kind = 'payable'                      THEN RETURN '2211'; END IF;
    RETURN 'unknown';
END;
$$;

-- Split FCR de um valor de settlement consoante o ratio FCR/(ord+fcr) da
-- charge original. Lê os credit-side de `charge_created` no ledger.
CREATE OR REPLACE FUNCTION finance.fn_charge_fcr_split(
  p_charge_id text,
  p_amount    integer,
  OUT ord_part integer,
  OUT fcr_part integer
) LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_fcr_total integer;
  v_ord_total integer;
BEGIN
  IF p_charge_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    ord_part := COALESCE(p_amount, 0);
    fcr_part := 0;
    RETURN;
  END IF;

  SELECT
    COALESCE(SUM(CASE WHEN account_code = '723' THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN account_code IN ('721', '722') THEN amount ELSE 0 END), 0)
  INTO v_fcr_total, v_ord_total
  FROM finance.ledger
  WHERE ref_type   = 'charge'
    AND ref_id     = p_charge_id
    AND entry_type = 'charge_created'
    AND direction  = 'credit';

  IF v_fcr_total = 0 OR (v_fcr_total + v_ord_total) = 0 THEN
    ord_part := p_amount;
    fcr_part := 0;
  ELSE
    fcr_part := ROUND(p_amount::numeric * v_fcr_total / (v_fcr_total + v_ord_total));
    ord_part := p_amount - fcr_part;
  END IF;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- charge: BEFORE UPDATE → updated_at + bloqueia cancel se há settlements ativos
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance.fn_charge_bu()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
        IF EXISTS (
            SELECT 1 FROM finance.settlement
             WHERE (debit_charge_id = NEW.id OR credit_charge_id = NEW.id)
               AND status = 'active'
        ) THEN
            RAISE EXCEPTION
                'Não é possível cancelar charge com settlements ativos. Reverta os settlements primeiro.';
        END IF;
        NEW.open_amount    := 0;
        NEW.settled_amount := 0;
        NEW.amount         := 0;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_charge_bu ON finance.charge;
CREATE TRIGGER trg_charge_bu BEFORE UPDATE ON finance.charge
    FOR EACH ROW EXECUTE FUNCTION finance.fn_charge_bu();

-- ═══════════════════════════════════════════════════════════════════════════════
-- charge: AFTER INSERT → emite ledger Dr/Cr (com FCR split para quotas)
-- O auto-offset foi movido para TS (charge/auto_offset.ts).
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance.fn_charge_ai()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_acc_debit      varchar;
    v_acc_credit     varchar;
    v_fcr_pct        numeric;
    v_fcr_amount     integer;
    v_ord_amount     integer;
    v_source_charge  finance.charge%ROWTYPE;
BEGIN
    IF NEW.nature <> 'debit' THEN RETURN NEW; END IF;

    v_acc_debit  := finance.fn_charge_account(NEW.kind, NEW.nature, NEW.charge_type, NEW.account_id);
    v_acc_credit := finance.fn_counterparty_account(NEW.kind, NEW.charge_type);

    -- ── Caso 1: quota (com possível FCR split em 2 linhas de crédito) ─────
    IF NEW.charge_type = 'quota' THEN
        SELECT fcr_percentage INTO v_fcr_pct FROM core.budget WHERE id = NEW.source_id;
        v_fcr_pct    := COALESCE(v_fcr_pct, 0);
        v_ord_amount := ROUND(NEW.original_amount::numeric / (1 + v_fcr_pct / 100));
        v_fcr_amount := NEW.original_amount - v_ord_amount;

        INSERT INTO finance.ledger
            (condominium_id, unit_id, entry_date, entry_type,
             account_code, direction, amount, description, ref_type, ref_id)
        VALUES
            (NEW.condominium_id, NEW.unit_id, NEW.issue_date, 'charge_created',
             v_acc_debit, 'debit', NEW.original_amount, NEW.description,
             'charge', NEW.id);

        IF v_ord_amount > 0 THEN
            INSERT INTO finance.ledger
                (condominium_id, unit_id, entry_date, entry_type,
                 account_code, direction, amount, description, ref_type, ref_id)
            VALUES
                (NEW.condominium_id, NEW.unit_id, NEW.issue_date, 'charge_created',
                 '721', 'credit', v_ord_amount, NEW.description,
                 'charge', NEW.id);
        END IF;
        IF v_fcr_amount > 0 THEN
            INSERT INTO finance.ledger
                (condominium_id, unit_id, entry_date, entry_type,
                 account_code, direction, amount, description, ref_type, ref_id)
            VALUES
                (NEW.condominium_id, NEW.unit_id, NEW.issue_date, 'charge_created',
                 '723', 'credit', v_fcr_amount, NEW.description || ' (FCR)',
                 'charge', NEW.id);
        END IF;
        RETURN NEW;
    END IF;

    -- ── Caso 2: refaturação (Cr conta da despesa original) ───────────────
    IF NEW.charge_type = 'refacturation' THEN
        IF NEW.source_type = 'refacturation' AND NEW.source_id IS NOT NULL THEN
            SELECT * INTO v_source_charge FROM finance.charge WHERE id = NEW.source_id;
            v_acc_credit := finance.fn_charge_account(
                v_source_charge.kind, v_source_charge.nature,
                v_source_charge.charge_type, v_source_charge.account_id);
        ELSE
            v_acc_credit := '7888';
        END IF;

        INSERT INTO finance.ledger
            (condominium_id, unit_id, entry_date, entry_type,
             account_code, direction, amount, description, ref_type, ref_id)
        VALUES
            (NEW.condominium_id, NEW.unit_id, NEW.issue_date, 'charge_created',
             v_acc_debit,  'debit',  NEW.original_amount, NEW.description,
             'charge', NEW.id),
            (NEW.condominium_id, NEW.unit_id, NEW.issue_date, 'charge_created',
             v_acc_credit, 'credit', NEW.original_amount, 'Refaturação: ' || NEW.description,
             'charge', NEW.id);
        RETURN NEW;
    END IF;

    -- ── Caso 3: genérico (despesa, opening_balance, charge avulsa) ────────
    INSERT INTO finance.ledger
        (condominium_id, unit_id, entry_date, entry_type,
         account_code, direction, amount, description, ref_type, ref_id)
    VALUES
        (NEW.condominium_id, NEW.unit_id, NEW.issue_date, 'charge_created',
         v_acc_debit,  'debit',  NEW.original_amount, NEW.description,
         'charge', NEW.id),
        (NEW.condominium_id, NEW.unit_id, NEW.issue_date, 'charge_created',
         v_acc_credit, 'credit', NEW.original_amount, NEW.description,
         'charge', NEW.id);

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_charge_ai ON finance.charge;
CREATE TRIGGER trg_charge_ai AFTER INSERT ON finance.charge
    FOR EACH ROW EXECUTE FUNCTION finance.fn_charge_ai();

-- ═══════════════════════════════════════════════════════════════════════════════
-- charge: AFTER UPDATE → ledger inverso quando charge é cancelled
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance.fn_charge_au()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_acc_debit  varchar;
    v_acc_credit varchar;
BEGIN
    IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
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

DROP TRIGGER IF EXISTS trg_charge_au ON finance.charge;
CREATE TRIGGER trg_charge_au AFTER UPDATE ON finance.charge
    FOR EACH ROW EXECUTE FUNCTION finance.fn_charge_au();

-- ═══════════════════════════════════════════════════════════════════════════════
-- settlement: BEFORE INSERT → safety net (validações mínimas, TS valida antes)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance.fn_settlement_bi()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_charge_open integer;
BEGIN
    IF NEW.amount <= 0 THEN
        RAISE EXCEPTION 'settlement.amount tem de ser > 0 (atual: %)', NEW.amount;
    END IF;

    IF NEW.settlement_type = 'charge_offset' THEN
        IF NEW.debit_charge_id IS NULL OR NEW.credit_charge_id IS NULL THEN
            RAISE EXCEPTION 'charge_offset requer debit_charge_id E credit_charge_id';
        END IF;
        IF NEW.bank_transaction_id IS NOT NULL THEN
            RAISE EXCEPTION 'charge_offset não pode ter bank_transaction_id';
        END IF;
        -- Safety net: amount não pode exceder open_amount de nenhuma das charges
        SELECT open_amount INTO v_charge_open FROM finance.charge WHERE id = NEW.debit_charge_id;
        IF v_charge_open IS NOT NULL AND NEW.amount > v_charge_open THEN
            RAISE EXCEPTION 'settlement.amount (%) excede open_amount do débito (%)', NEW.amount, v_charge_open;
        END IF;
        SELECT open_amount INTO v_charge_open FROM finance.charge WHERE id = NEW.credit_charge_id;
        IF v_charge_open IS NOT NULL AND NEW.amount > v_charge_open THEN
            RAISE EXCEPTION 'settlement.amount (%) excede open_amount do crédito (%)', NEW.amount, v_charge_open;
        END IF;
    ELSIF NEW.settlement_type = 'bank_reconciliation' THEN
        IF NEW.bank_transaction_id IS NULL THEN
            RAISE EXCEPTION 'bank_reconciliation requer bank_transaction_id';
        END IF;
        IF (NEW.debit_charge_id IS NULL) = (NEW.credit_charge_id IS NULL) THEN
            RAISE EXCEPTION 'bank_reconciliation requer debit_charge_id OU credit_charge_id (não ambos, não nenhum)';
        END IF;
        -- Safety net: amount não pode exceder open_amount da charge envolvida
        SELECT open_amount INTO v_charge_open FROM finance.charge
         WHERE id = COALESCE(NEW.debit_charge_id, NEW.credit_charge_id);
        IF v_charge_open IS NOT NULL AND NEW.amount > v_charge_open THEN
            RAISE EXCEPTION 'settlement.amount (%) excede open_amount da charge (%)', NEW.amount, v_charge_open;
        END IF;
    ELSIF NEW.settlement_type = 'bank_deposit_credit' THEN
        IF NEW.bank_transaction_id IS NULL OR NEW.credit_charge_id IS NULL THEN
            RAISE EXCEPTION 'bank_deposit_credit requer bank_transaction_id E credit_charge_id';
        END IF;
        IF NEW.debit_charge_id IS NOT NULL THEN
            RAISE EXCEPTION 'bank_deposit_credit não pode ter debit_charge_id';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_settlement_bi ON finance.settlement;
CREATE TRIGGER trg_settlement_bi BEFORE INSERT ON finance.settlement
    FOR EACH ROW EXECUTE FUNCTION finance.fn_settlement_bi();

-- ═══════════════════════════════════════════════════════════════════════════════
-- settlement: AFTER INSERT → emite ledger Dr/Cr
-- (charge updates + bank_tx status passou para TS - settlement/effects.ts)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance.fn_settlement_ai()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_charge        finance.charge%ROWTYPE;
    v_acc_charge    varchar;
    v_btx_sign      integer;
    v_split         record;
    v_charge_id     text;
BEGIN
    IF NEW.status <> 'active' THEN RETURN NEW; END IF;

    -- ── charge_offset: 2 linhas (Dr conta credit / Cr conta debit) ────────
    IF NEW.settlement_type = 'charge_offset' THEN
        SELECT * INTO v_charge FROM finance.charge WHERE id = NEW.credit_charge_id;
        v_acc_charge := finance.fn_charge_account(v_charge.kind, v_charge.nature,
                                           v_charge.charge_type, v_charge.account_id);
        INSERT INTO finance.ledger
            (condominium_id, unit_id, entry_date, entry_type, account_code,
             direction, amount, description, ref_type, ref_id)
        VALUES
            (NEW.condominium_id, NEW.unit_id, NEW.settlement_date, 'settlement_applied',
             v_acc_charge, 'debit', NEW.amount, NEW.notes,
             'settlement', NEW.id);

        SELECT * INTO v_charge FROM finance.charge WHERE id = NEW.debit_charge_id;
        v_acc_charge := finance.fn_charge_account(v_charge.kind, v_charge.nature,
                                           v_charge.charge_type, v_charge.account_id);
        INSERT INTO finance.ledger
            (condominium_id, unit_id, entry_date, entry_type, account_code,
             direction, amount, description, ref_type, ref_id)
        VALUES
            (NEW.condominium_id, NEW.unit_id, NEW.settlement_date, 'settlement_applied',
             v_acc_charge, 'credit', NEW.amount, NEW.notes,
             'settlement', NEW.id);
        RETURN NEW;
    END IF;

    -- ── bank_deposit_credit: Dr 121 / Cr conta da credit_charge ───────────
    IF NEW.settlement_type = 'bank_deposit_credit' THEN
        SELECT * INTO v_charge FROM finance.charge WHERE id = NEW.credit_charge_id;
        v_acc_charge := finance.fn_charge_account(v_charge.kind, v_charge.nature,
                                           v_charge.charge_type, v_charge.account_id);
        INSERT INTO finance.ledger
            (condominium_id, unit_id, entry_date, entry_type, account_code,
             direction, amount, description, ref_type, ref_id)
        VALUES
            (NEW.condominium_id, NULL, NEW.settlement_date, 'bank_deposit_credit',
             '121', 'debit', NEW.amount, NEW.notes,
             'settlement', NEW.id),
            (NEW.condominium_id, NEW.unit_id, NEW.settlement_date, 'bank_deposit_credit',
             v_acc_charge, 'credit', NEW.amount, NEW.notes,
             'settlement', NEW.id);
        RETURN NEW;
    END IF;

    -- ── bank_reconciliation: split FCR no lado bancário ───────────────────
    IF NEW.settlement_type = 'bank_reconciliation' THEN
        v_charge_id := COALESCE(NEW.debit_charge_id, NEW.credit_charge_id);
        SELECT * INTO v_charge FROM finance.charge WHERE id = v_charge_id;
        v_acc_charge := finance.fn_charge_account(v_charge.kind, v_charge.nature,
                                           v_charge.charge_type, v_charge.account_id);
        SELECT SIGN(amount) INTO v_btx_sign FROM finance.bank_transaction
         WHERE id = NEW.bank_transaction_id;
        SELECT * INTO v_split FROM finance.fn_charge_fcr_split(v_charge_id, NEW.amount);

        IF v_btx_sign > 0 THEN
            -- Entrada: Dr Banco (split ord/FCR) / Cr conta charge (total)
            IF v_split.ord_part > 0 THEN
                INSERT INTO finance.ledger
                    (condominium_id, unit_id, entry_date, entry_type, account_code,
                     direction, amount, description, ref_type, ref_id)
                VALUES
                    (NEW.condominium_id, NULL, NEW.settlement_date, 'bank_reconciliation',
                     '121', 'debit', v_split.ord_part, NEW.notes,
                     'settlement', NEW.id);
            END IF;
            IF v_split.fcr_part > 0 THEN
                INSERT INTO finance.ledger
                    (condominium_id, unit_id, entry_date, entry_type, account_code,
                     direction, amount, description, ref_type, ref_id)
                VALUES
                    (NEW.condominium_id, NULL, NEW.settlement_date, 'bank_reconciliation',
                     '122', 'debit', v_split.fcr_part,
                     COALESCE(NEW.notes, '') || ' (FCR)',
                     'settlement', NEW.id);
            END IF;
            INSERT INTO finance.ledger
                (condominium_id, unit_id, entry_date, entry_type, account_code,
                 direction, amount, description, ref_type, ref_id)
            VALUES
                (NEW.condominium_id, NEW.unit_id, NEW.settlement_date, 'bank_reconciliation',
                 v_acc_charge, 'credit', NEW.amount, NEW.notes,
                 'settlement', NEW.id);
        ELSE
            -- Saída: Dr conta charge (total) / Cr Banco (split ord/FCR)
            INSERT INTO finance.ledger
                (condominium_id, unit_id, entry_date, entry_type, account_code,
                 direction, amount, description, ref_type, ref_id)
            VALUES
                (NEW.condominium_id, NEW.unit_id, NEW.settlement_date, 'bank_reconciliation',
                 v_acc_charge, 'debit', NEW.amount, NEW.notes,
                 'settlement', NEW.id);
            IF v_split.ord_part > 0 THEN
                INSERT INTO finance.ledger
                    (condominium_id, unit_id, entry_date, entry_type, account_code,
                     direction, amount, description, ref_type, ref_id)
                VALUES
                    (NEW.condominium_id, NULL, NEW.settlement_date, 'bank_reconciliation',
                     '121', 'credit', v_split.ord_part, NEW.notes,
                     'settlement', NEW.id);
            END IF;
            IF v_split.fcr_part > 0 THEN
                INSERT INTO finance.ledger
                    (condominium_id, unit_id, entry_date, entry_type, account_code,
                     direction, amount, description, ref_type, ref_id)
                VALUES
                    (NEW.condominium_id, NULL, NEW.settlement_date, 'bank_reconciliation',
                     '122', 'credit', v_split.fcr_part,
                     COALESCE(NEW.notes, '') || ' (FCR)',
                     'settlement', NEW.id);
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_settlement_ai ON finance.settlement;
CREATE TRIGGER trg_settlement_ai AFTER INSERT ON finance.settlement
    FOR EACH ROW EXECUTE FUNCTION finance.fn_settlement_ai();

-- ═══════════════════════════════════════════════════════════════════════════════
-- settlement: AFTER UPDATE → emite ledger inverso quando active → reversed
-- (charge restore + bank_tx status + cancel credit_balance + bloqueio se
--  consumida → todos para TS)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance.fn_settlement_au()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_charge     finance.charge%ROWTYPE;
    v_acc_charge varchar;
    v_btx_sign   integer;
    v_split      record;
    v_charge_id  text;
BEGIN
    IF NEW.status <> 'reversed' OR OLD.status <> 'active' THEN RETURN NEW; END IF;

    IF OLD.settlement_type = 'charge_offset' THEN
        SELECT * INTO v_charge FROM finance.charge WHERE id = OLD.credit_charge_id;
        v_acc_charge := finance.fn_charge_account(v_charge.kind, v_charge.nature,
                                           v_charge.charge_type, v_charge.account_id);
        INSERT INTO finance.ledger
            (condominium_id, unit_id, entry_date, entry_type, account_code,
             direction, amount, description, ref_type, ref_id)
        VALUES
            (NEW.condominium_id, NEW.unit_id, CURRENT_DATE, 'settlement_reversed',
             v_acc_charge, 'credit', OLD.amount, 'Reversão: ' || OLD.notes,
             'settlement', NEW.id);

        SELECT * INTO v_charge FROM finance.charge WHERE id = OLD.debit_charge_id;
        v_acc_charge := finance.fn_charge_account(v_charge.kind, v_charge.nature,
                                           v_charge.charge_type, v_charge.account_id);
        INSERT INTO finance.ledger
            (condominium_id, unit_id, entry_date, entry_type, account_code,
             direction, amount, description, ref_type, ref_id)
        VALUES
            (NEW.condominium_id, NEW.unit_id, CURRENT_DATE, 'settlement_reversed',
             v_acc_charge, 'debit', OLD.amount, 'Reversão: ' || OLD.notes,
             'settlement', NEW.id);
        RETURN NEW;
    END IF;

    IF OLD.settlement_type = 'bank_deposit_credit' THEN
        SELECT * INTO v_charge FROM finance.charge WHERE id = OLD.credit_charge_id;
        v_acc_charge := finance.fn_charge_account(v_charge.kind, v_charge.nature,
                                           v_charge.charge_type, v_charge.account_id);
        INSERT INTO finance.ledger
            (condominium_id, unit_id, entry_date, entry_type, account_code,
             direction, amount, description, ref_type, ref_id)
        VALUES
            (NEW.condominium_id, NULL, CURRENT_DATE, 'settlement_reversed',
             '121', 'credit', OLD.amount, 'Reversão: ' || OLD.notes,
             'settlement', NEW.id),
            (NEW.condominium_id, NEW.unit_id, CURRENT_DATE, 'settlement_reversed',
             v_acc_charge, 'debit', OLD.amount, 'Reversão: ' || OLD.notes,
             'settlement', NEW.id);
        RETURN NEW;
    END IF;

    IF OLD.settlement_type = 'bank_reconciliation' THEN
        v_charge_id := COALESCE(OLD.debit_charge_id, OLD.credit_charge_id);
        SELECT * INTO v_charge FROM finance.charge WHERE id = v_charge_id;
        v_acc_charge := finance.fn_charge_account(v_charge.kind, v_charge.nature,
                                           v_charge.charge_type, v_charge.account_id);
        SELECT SIGN(amount) INTO v_btx_sign FROM finance.bank_transaction
         WHERE id = OLD.bank_transaction_id;
        SELECT * INTO v_split FROM finance.fn_charge_fcr_split(v_charge_id, OLD.amount);

        IF v_btx_sign > 0 THEN
            -- Reverter entrada: Cr Banco / Dr conta
            IF v_split.ord_part > 0 THEN
                INSERT INTO finance.ledger
                    (condominium_id, unit_id, entry_date, entry_type, account_code,
                     direction, amount, description, ref_type, ref_id)
                VALUES
                    (NEW.condominium_id, NULL, CURRENT_DATE, 'settlement_reversed',
                     '121', 'credit', v_split.ord_part, 'Reversão: ' || OLD.notes,
                     'settlement', NEW.id);
            END IF;
            IF v_split.fcr_part > 0 THEN
                INSERT INTO finance.ledger
                    (condominium_id, unit_id, entry_date, entry_type, account_code,
                     direction, amount, description, ref_type, ref_id)
                VALUES
                    (NEW.condominium_id, NULL, CURRENT_DATE, 'settlement_reversed',
                     '122', 'credit', v_split.fcr_part,
                     'Reversão: ' || COALESCE(OLD.notes, '') || ' (FCR)',
                     'settlement', NEW.id);
            END IF;
            INSERT INTO finance.ledger
                (condominium_id, unit_id, entry_date, entry_type, account_code,
                 direction, amount, description, ref_type, ref_id)
            VALUES
                (NEW.condominium_id, NEW.unit_id, CURRENT_DATE, 'settlement_reversed',
                 v_acc_charge, 'debit', OLD.amount, 'Reversão: ' || OLD.notes,
                 'settlement', NEW.id);
        ELSE
            -- Reverter saída: Cr conta / Dr Banco
            INSERT INTO finance.ledger
                (condominium_id, unit_id, entry_date, entry_type, account_code,
                 direction, amount, description, ref_type, ref_id)
            VALUES
                (NEW.condominium_id, NEW.unit_id, CURRENT_DATE, 'settlement_reversed',
                 v_acc_charge, 'credit', OLD.amount, 'Reversão: ' || OLD.notes,
                 'settlement', NEW.id);
            IF v_split.ord_part > 0 THEN
                INSERT INTO finance.ledger
                    (condominium_id, unit_id, entry_date, entry_type, account_code,
                     direction, amount, description, ref_type, ref_id)
                VALUES
                    (NEW.condominium_id, NULL, CURRENT_DATE, 'settlement_reversed',
                     '121', 'debit', v_split.ord_part, 'Reversão: ' || OLD.notes,
                     'settlement', NEW.id);
            END IF;
            IF v_split.fcr_part > 0 THEN
                INSERT INTO finance.ledger
                    (condominium_id, unit_id, entry_date, entry_type, account_code,
                     direction, amount, description, ref_type, ref_id)
                VALUES
                    (NEW.condominium_id, NULL, CURRENT_DATE, 'settlement_reversed',
                     '122', 'debit', v_split.fcr_part,
                     'Reversão: ' || COALESCE(OLD.notes, '') || ' (FCR)',
                     'settlement', NEW.id);
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_settlement_au ON finance.settlement;
CREATE TRIGGER trg_settlement_au AFTER UPDATE ON finance.settlement
    FOR EACH ROW EXECUTE FUNCTION finance.fn_settlement_au();

-- ═══════════════════════════════════════════════════════════════════════════════
-- fn_charge_amount_adjust_ledger
-- Ledger delta quando original_amount é editado em charges payable simples.
-- Chamadas qualificadas (`finance.fn_X`): os helpers vivem no schema `finance`
-- e um nome sem schema não resolve.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance.fn_charge_amount_adjust_ledger()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_delta      integer;
  v_acc_debit  varchar;
  v_acc_credit varchar;
  v_dir_deb    varchar;
  v_dir_cred   varchar;
  v_abs        integer;
BEGIN
  IF NEW.original_amount = OLD.original_amount THEN RETURN NEW; END IF;
  IF OLD.nature <> 'debit' OR NEW.nature <> 'debit' THEN RETURN NEW; END IF;
  IF OLD.kind <> 'payable' OR NEW.kind <> 'payable' THEN RETURN NEW; END IF;
  IF NEW.charge_type = 'refacturation' THEN RETURN NEW; END IF;
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;

  v_delta := NEW.original_amount - OLD.original_amount;
  v_abs := abs(v_delta);

  v_acc_debit  := finance.fn_charge_account(NEW.kind, NEW.nature, NEW.charge_type, NEW.account_id);
  v_acc_credit := finance.fn_counterparty_account(NEW.kind, NEW.charge_type);

  IF v_delta > 0 THEN
    v_dir_deb  := 'debit';
    v_dir_cred := 'credit';
  ELSE
    v_dir_deb  := 'credit';
    v_dir_cred := 'debit';
  END IF;

  INSERT INTO finance.ledger
    (condominium_id, unit_id, entry_date, entry_type,
     account_code, direction, amount, description,
     ref_type, ref_id)
  VALUES
    (NEW.condominium_id, NEW.unit_id, CURRENT_DATE, 'charge_amount_adjusted',
     v_acc_debit, v_dir_deb, v_abs,
     'Ajuste valor: ' || NEW.description,
     'charge', NEW.id),
    (NEW.condominium_id, NEW.unit_id, CURRENT_DATE, 'charge_amount_adjusted',
     v_acc_credit, v_dir_cred, v_abs,
     'Ajuste valor: ' || NEW.description,
     'charge', NEW.id);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_charge_amount_adjust_ledger ON finance.charge;
CREATE TRIGGER trg_charge_amount_adjust_ledger
    AFTER UPDATE OF original_amount ON finance.charge
    FOR EACH ROW
    EXECUTE FUNCTION finance.fn_charge_amount_adjust_ledger();

-- ═══════════════════════════════════════════════════════════════════════════════
-- bank_transaction NÃO gera ledger diretamente (ver D14).
-- Trigger antigo removido na squash do bootstrap.
-- ═══════════════════════════════════════════════════════════════════════════════
DROP TRIGGER IF EXISTS trg_bank_transactions_ai_ledger ON finance.bank_transaction;
DROP FUNCTION IF EXISTS fn_bank_transactions_ai_ledger();
