-- 020_trg_tenant_guard.sql
-- Uma linha não aponta para uma entidade de outro condomínio. As FKs só verificam que
-- existe; a API valida o condomínio antes (assertOwnership, requireUnitInCondo) e isto
-- é a última barreira. Teste: test_sql/tests/0067_tenant_guard.sql.
--
-- Args do trigger, um por referência:
--   'coluna=schema.tabela'                          referência simples
--   'coluna@coluna_tipo=tipo:schema.tabela,...'     polimórfica (tipos fora da lista não validam)
-- Tabelas sem condominium_id herdam o condomínio da primeira referência.

-- Condomínio da linha `p_id` em `p_table`. NULL = não existe, ou é global (plano de contas).
CREATE OR REPLACE FUNCTION core.fn_tenant_of(p_table text, p_id text)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_cid text;
BEGIN
    IF p_table = 'core.assembly_agenda_item' THEN
        SELECT a.condominium_id INTO v_cid
          FROM core.assembly_agenda_item ai
          JOIN core.assembly a ON a.id = ai.assembly_id
         WHERE ai.id = p_id;
    ELSE
        EXECUTE format('SELECT condominium_id FROM %s WHERE id = $1', p_table::regclass)
           INTO v_cid USING p_id;
    END IF;
    RETURN v_cid;
END;
$$;

CREATE OR REPLACE FUNCTION core.fn_tenant_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_new      jsonb := to_jsonb(NEW);
    v_old      jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
    v_row_cid  text := v_new->>'condominium_id';
    v_changed  boolean := TG_OP = 'INSERT'
                          OR v_new->'condominium_id' IS DISTINCT FROM v_old->'condominium_id';
    v_spec     text;
    v_col      text;
    v_type_col text;
    v_target   text;
    v_id       text;
    v_ref_cid  text;
BEGIN
    -- UPDATE que não mexe em referências nem no condomínio: nada a validar (linhas antigas passam).
    IF NOT v_changed THEN
        FOREACH v_spec IN ARRAY TG_ARGV LOOP
            v_col := split_part(split_part(v_spec, '=', 1), '@', 1);
            v_type_col := split_part(split_part(v_spec, '=', 1), '@', 2);
            IF v_new->v_col IS DISTINCT FROM v_old->v_col
               OR (v_type_col <> '' AND v_new->v_type_col IS DISTINCT FROM v_old->v_type_col) THEN
                v_changed := true;
                EXIT;
            END IF;
        END LOOP;
        IF NOT v_changed THEN RETURN NEW; END IF;
    END IF;

    FOREACH v_spec IN ARRAY TG_ARGV LOOP
        v_col := split_part(split_part(v_spec, '=', 1), '@', 1);
        v_type_col := split_part(split_part(v_spec, '=', 1), '@', 2);
        v_id := v_new->>v_col;
        CONTINUE WHEN v_id IS NULL;

        v_target := split_part(v_spec, '=', 2);
        IF v_type_col <> '' THEN
            SELECT split_part(m, ':', 2) INTO v_target
              FROM unnest(string_to_array(v_target, ',')) AS m
             WHERE split_part(m, ':', 1) = v_new->>v_type_col;
            CONTINUE WHEN v_target IS NULL;
        END IF;

        v_ref_cid := core.fn_tenant_of(v_target, v_id);
        CONTINUE WHEN v_ref_cid IS NULL;

        IF v_row_cid IS NULL THEN
            v_row_cid := v_ref_cid;
        ELSIF v_ref_cid <> v_row_cid THEN
            -- Condomínio da linha inexistente: a FK recusa a seguir, com o erro dela.
            IF NOT EXISTS (SELECT 1 FROM core.condominium WHERE id = v_row_cid) THEN
                RETURN NEW;
            END IF;
            -- Sem ids na mensagem: chega ao cliente (400) e não deve confirmar o outro condomínio.
            RAISE EXCEPTION 'Referência de outro condomínio em %.%.%', TG_TABLE_SCHEMA, TG_TABLE_NAME, v_col
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$;

-- Nome depois dos outros BEFORE (ordem alfabética): valida os valores já derivados.
DO $$
DECLARE
    v_guard record;
BEGIN
    FOR v_guard IN
        SELECT * FROM (VALUES
            ('core.assembly', ARRAY['minutes_document_id=core.document',
                'president_occupant_id=core.occupant', 'secretary_occupant_id=core.occupant']),
            ('core.assembly_agenda_item', ARRAY['assembly_id=core.assembly',
                'ref_id@ref_type=budget:core.budget']),
            ('core.assembly_attendee', ARRAY['assembly_id=core.assembly', 'unit_id=core.unit',
                'occupant_id=core.occupant', 'proxy_holder_occupant_id=core.occupant']),
            ('core.assembly_convocation', ARRAY['assembly_id=core.assembly']),
            ('core.assembly_vote', ARRAY['assembly_agenda_item_id=core.assembly_agenda_item',
                'unit_id=core.unit', 'occupant_id=core.occupant']),
            ('core.attachment', ARRAY['entity_id@entity_type=charge:finance.charge,'
                'ticket:core.ticket,inspection:core.inspection,assembly:core.assembly,'
                'insurance:core.insurance_policy,document:core.document,pathology:core.pathology']),
            ('core.billing_reminder', ARRAY['unit_id=core.unit']),
            ('core.budget', ARRAY['parent_budget_id=core.budget']),
            ('core.budget_line', ARRAY['budget_id=core.budget', 'account_id=finance.chart_of_account']),
            ('core.inspection', ARRAY['supplier_id=core.supplier']),
            ('core.insurance_policy', ARRAY['unit_id=core.unit', 'renewed_from_id=core.insurance_policy']),
            ('core.insurance_reminder', ARRAY['unit_id=core.unit']),
            ('core.pathology_unit', ARRAY['pathology_id=core.pathology', 'unit_id=core.unit']),
            ('core.payment_plan', ARRAY['unit_id=core.unit']),
            ('core.quota_generation_run', ARRAY['budget_id=core.budget']),
            ('core.recurring_template', ARRAY['account_id=finance.chart_of_account',
                'supplier_id=core.supplier', 'unit_id=core.unit']),
            ('core.supplier', ARRAY['account_id=finance.chart_of_account']),
            ('core.ticket', ARRAY['unit_id=core.unit', 'pathology_id=core.pathology',
                'reported_by_occupant_id=core.occupant']),
            ('core.ticket_comment', ARRAY['ticket_id=core.ticket']),
            ('core.unit_occupant', ARRAY['unit_id=core.unit', 'occupant_id=core.occupant']),
            ('finance.bank_import_batch', ARRAY['bank_account_id=finance.bank_account']),
            ('finance.bank_transaction', ARRAY['bank_account_id=finance.bank_account',
                'import_batch_id=finance.bank_import_batch',
                'reversed_by_transaction_id=finance.bank_transaction']),
            ('finance.charge', ARRAY['unit_id=core.unit', 'account_id=finance.chart_of_account',
                'supplier_id=core.supplier', 'recurring_template_id=core.recurring_template',
                'budget_id=core.budget',
                'source_id@source_type=budget:core.budget,recurring_template:core.recurring_template,'
                'refacturation:finance.charge,supplier_refund:finance.charge,'
                'bank_transaction:finance.bank_transaction,bank_account:finance.bank_account']),
            ('finance.fiscal_year', ARRAY['closed_assembly_id=core.assembly']),
            ('finance.receipt', ARRAY['unit_id=core.unit', 'bank_transaction_id=finance.bank_transaction']),
            ('finance.receipt_skip', ARRAY['unit_id=core.unit', 'bank_transaction_id=finance.bank_transaction']),
            ('finance.settlement', ARRAY['unit_id=core.unit', 'debit_charge_id=finance.charge',
                'credit_charge_id=finance.charge', 'bank_transaction_id=finance.bank_transaction',
                'debit_ref_id@debit_ref_type=charge:finance.charge,bank_transaction:finance.bank_transaction',
                'credit_ref_id@credit_ref_type=charge:finance.charge,bank_transaction:finance.bank_transaction'])
        ) AS g(tbl, specs)
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_tenant_guard ON %s', v_guard.tbl);
        EXECUTE format(
            'CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON %s '
            'FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard(%s)',
            v_guard.tbl,
            (SELECT string_agg(quote_literal(s), ', ') FROM unnest(v_guard.specs) AS s)
        );
    END LOOP;
END;
$$;
