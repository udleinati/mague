-- 001_bootstrap.sql
-- Schema completo da BD (pg_dump --schema-only) + dados de referência. BDs novas partem
-- daqui; mudanças de schema entram como migrations novas (002+). Não editar à mão:
-- para regenerar, ver docs/agents/operations.md.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: audit; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA audit;


--
-- Name: core; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA core;


--
-- Name: finance; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA finance;


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: fn_attach_on_create(); Type: FUNCTION; Schema: audit; Owner: -
--

CREATE OR REPLACE FUNCTION audit.fn_attach_on_create() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT object_identity, schema_name
      FROM pg_event_trigger_ddl_commands()
      WHERE command_tag = 'CREATE TABLE'
        AND schema_name IN ('core', 'finance')
  LOOP
    PERFORM audit.fn_attach_to_table(
      split_part(r.object_identity, '.', 1),
      split_part(r.object_identity, '.', 2)
    );
  END LOOP;
END;
$$;


--
-- Name: fn_attach_to_table(text, text); Type: FUNCTION; Schema: audit; Owner: -
--

CREATE OR REPLACE FUNCTION audit.fn_attach_to_table(p_schema text, p_table text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_trigger_name   text := format('trg_audit_%s_%s', p_schema, p_table);
  v_relkind        char;
  v_relispartition boolean;
BEGIN
  -- skip_list
  IF EXISTS (
    SELECT 1 FROM audit.cdc_skip_list
    WHERE schema_name = p_schema AND table_name = p_table
  ) THEN
    RETURN;
  END IF;

  -- Verifica que a tabela existe e que tipo é
  SELECT c.relkind, c.relispartition
    INTO v_relkind, v_relispartition
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = p_schema AND c.relname = p_table;

  IF v_relkind IS NULL THEN
    RETURN;  -- tabela não existe
  END IF;

  -- Só ordinary tables ('r') ou partitioned tables ('p').
  -- Excluímos partitions filhas - o trigger na parent cobre as filhas.
  IF v_relkind NOT IN ('r', 'p') OR v_relispartition THEN
    RETURN;
  END IF;

  -- Já tem trigger?
  IF EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE t.tgname = v_trigger_name
        AND n.nspname = p_schema
        AND c.relname = p_table
  ) THEN
    RETURN;
  END IF;

  EXECUTE format(
    'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
    'FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change()',
    v_trigger_name, p_schema, p_table
  );
END;
$$;


--
-- Name: FUNCTION fn_attach_to_table(p_schema text, p_table text); Type: COMMENT; Schema: audit; Owner: -
--

COMMENT ON FUNCTION audit.fn_attach_to_table(p_schema text, p_table text) IS 'Attach audit.fn_log_change a uma tabela. Idempotente. Respeita skip_list e ignora partitions filhas.';


--
-- Name: fn_log_change(); Type: FUNCTION; Schema: audit; Owner: -
--

CREATE OR REPLACE FUNCTION audit.fn_log_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_old       jsonb;
  v_new       jsonb;
  v_action    text;
  v_actor     jsonb;
  v_actor_id  text;
  v_condo_id  text;
  v_row_id    text;
  v_diff      jsonb;
  v_snapshot  jsonb;
  v_before    jsonb;
  v_after     jsonb;
BEGIN
  -- Skip tabelas marcadas (defesa extra; o attach já filtra por skip_list,
  -- mas se alguém attachar manualmente fica seguro).
  IF EXISTS (
    SELECT 1 FROM audit.cdc_skip_list
    WHERE schema_name = TG_TABLE_SCHEMA AND table_name = TG_TABLE_NAME
  ) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- to_jsonb(record)->'col' devolve JSONB 'null' (não SQL NULL) para colunas
  -- SQL NULL - por isso usamos NULLIF para tratar JSON null como ausência.
  IF TG_OP = 'INSERT' THEN
    v_action   := 'insert';
    v_new      := to_jsonb(NEW);
    v_actor    := NULLIF(v_new -> 'created_by', 'null'::jsonb);
    v_snapshot := v_new;
  ELSIF TG_OP = 'UPDATE' THEN
    v_action := 'update';
    v_new    := to_jsonb(NEW);
    v_old    := to_jsonb(OLD);
    -- Em soft-delete (deleted_by passa de NULL para valor), prioriza deleted_by
    v_actor  := COALESCE(
      NULLIF(v_new -> 'deleted_by', 'null'::jsonb),
      NULLIF(v_new -> 'updated_by', 'null'::jsonb)
    );
    -- diff: apenas as colunas que mudaram, com valores antes/depois.
    SELECT jsonb_object_agg(key, v_old -> key),
           jsonb_object_agg(key, v_new -> key)
      INTO v_before, v_after
      FROM jsonb_each(v_new) AS kv(key, value)
      WHERE kv.value IS DISTINCT FROM (v_old -> kv.key);
    IF v_before IS NOT NULL THEN
      v_diff := jsonb_build_object('before', v_before, 'after', v_after);
    END IF;
    v_snapshot := v_new;
  ELSE -- DELETE
    v_action   := 'delete';
    v_old      := to_jsonb(OLD);
    v_actor    := NULLIF(v_old -> 'deleted_by', 'null'::jsonb);
    v_snapshot := v_old;  -- estado pré-delete preservado
  END IF;

  -- Fallback para GUC quando a tabela não tem actorColumn ou actor está vazio.
  -- ADR 0011: chave canónica é `user_id` (não `id`).
  IF v_actor IS NULL OR v_actor = '{}'::jsonb THEN
    v_actor_id := nullif(current_setting('app.user_id', true), '');
    IF v_actor_id IS NOT NULL THEN
      v_actor := jsonb_strip_nulls(jsonb_build_object(
        'user_id',    v_actor_id,
        'email',      nullif(current_setting('app.user_email', true), ''),
        'ip',         nullif(current_setting('app.ip',         true), ''),
        'user_agent', nullif(current_setting('app.user_agent', true), ''),
        'request_id', nullif(current_setting('app.request_id', true), '')
      ));
    END IF;
  END IF;

  -- Tenant: row primeiro, GUC depois
  v_condo_id := COALESCE(
    v_new ->> 'condominium_id',
    v_old ->> 'condominium_id',
    nullif(current_setting('app.condominium_id', true), '')
  );

  -- Row id: assume convenção do projeto (coluna `id` text/nanoid).
  -- Tabelas com PK composta sem coluna `id` ficam fora - adicionar caso a caso.
  v_row_id := COALESCE(v_new ->> 'id', v_old ->> 'id');
  IF v_row_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  INSERT INTO audit.cdc_log (
    condominium_id, actor, table_schema, table_name, row_id,
    action, diff, snapshot
  ) VALUES (
    v_condo_id, v_actor, TG_TABLE_SCHEMA, TG_TABLE_NAME, v_row_id,
    v_action, v_diff, v_snapshot
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: FUNCTION fn_log_change(); Type: COMMENT; Schema: audit; Owner: -
--

COMMENT ON FUNCTION audit.fn_log_change() IS 'Trigger AFTER INSERT/UPDATE/DELETE genérico. SECURITY DEFINER: insere em audit.cdc_log mesmo com REVOKE para PUBLIC.';


--
-- Name: fn_reject_direct_insert(); Type: FUNCTION; Schema: audit; Owner: -
--

CREATE OR REPLACE FUNCTION audit.fn_reject_direct_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Permitimos INSERT apenas se vier de dentro de outro trigger
  -- (ex.: audit.fn_log_change quando a app escreve em core.charge etc).
  -- Inserts diretos via SQL não têm `pg_trigger_depth() >= 2` aqui.
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'audit.log INSERT direto é proibido (forge protection). '
      'Inserts só devem vir de audit.fn_log_change.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: fn_reject_modification(); Type: FUNCTION; Schema: audit; Owner: -
--

CREATE OR REPLACE FUNCTION audit.fn_reject_modification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'audit.cdc_log is append-only (% rejected on %.%)',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$;


--
-- Name: fn_assembly_held_approve_budgets(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE OR REPLACE FUNCTION core.fn_assembly_held_approve_budgets() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  d          record;
  b          record;
  line_count integer;
  dup_count  integer;
BEGIN
  -- Só dispara quando status passa para 'held' (qualquer estado anterior).
  IF NEW.status <> 'held' OR OLD.status = 'held' THEN
    RETURN NEW;
  END IF;

  FOR d IN
    SELECT ai.ref_id, ai.subject
      FROM core.assembly_agenda_item ai
     WHERE ai.assembly_id = NEW.id
       AND ai.deleted_at IS NULL
       AND ai.item_type = 'approve_budget'
       AND ai.approved = true
       AND ai.ref_type = 'budget'
       AND ai.ref_id IS NOT NULL
  LOOP
    SELECT * INTO b
      FROM core.budget
     WHERE id = d.ref_id
       AND condominium_id = NEW.condominium_id
       AND deleted_at IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Deliberação "%": orçamento % não encontrado ou apagado',
        d.subject, d.ref_id;
    END IF;

    -- Idempotente: se já aprovado, segue.
    IF b.status = 'approved' THEN
      CONTINUE;
    END IF;

    -- Validação 1: tem de ter pelo menos uma linha.
    SELECT COUNT(*) INTO line_count
      FROM core.budget_line
     WHERE budget_id = b.id AND deleted_at IS NULL;

    IF line_count = 0 THEN
      RAISE EXCEPTION
        'Deliberação "%": orçamento % não pode ser aprovado - sem linhas de despesa',
        d.subject, b.id;
    END IF;

    -- Validação 2: principal único por ano.
    IF b.type = 'principal' THEN
      SELECT COUNT(*) INTO dup_count
        FROM core.budget
       WHERE condominium_id = b.condominium_id
         AND year = b.year
         AND type = 'principal'
         AND status = 'approved'
         AND id <> b.id
         AND deleted_at IS NULL;

      IF dup_count > 0 THEN
        RAISE EXCEPTION
          'Deliberação "%": já existe orçamento principal aprovado para o ano %',
          d.subject, b.year;
      END IF;
    END IF;

    UPDATE core.budget
       SET status      = 'approved',
           approved_at = NOW(),
           updated_at  = NOW()
     WHERE id = b.id;
  END LOOP;

  RETURN NEW;
END;
$$;


--
-- Name: fn_assembly_vote_aggregate(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE OR REPLACE FUNCTION core.fn_assembly_vote_aggregate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_agenda_item_id text;
BEGIN
  -- Decidir qual ponto da ordem do dia foi tocado (INSERT/UPDATE usam NEW;
  -- DELETE usa OLD).
  v_agenda_item_id := COALESCE(NEW.assembly_agenda_item_id, OLD.assembly_agenda_item_id);

  -- Re-agrega totais excluindo soft-deleted. Numeric arithmetic - SUM devolve
  -- NULL para sets vazios, COALESCE → 0.
  UPDATE core.assembly_agenda_item d
     SET votes_in_favor = COALESCE((
           SELECT SUM(permillage_applied)
             FROM core.assembly_vote
            WHERE assembly_agenda_item_id = d.id
              AND vote = 'favor'
              AND deleted_at IS NULL
         ), 0),
         votes_against = COALESCE((
           SELECT SUM(permillage_applied)
             FROM core.assembly_vote
            WHERE assembly_agenda_item_id = d.id
              AND vote = 'against'
              AND deleted_at IS NULL
         ), 0),
         votes_abstain = COALESCE((
           SELECT SUM(permillage_applied)
             FROM core.assembly_vote
            WHERE assembly_agenda_item_id = d.id
              AND vote = 'abstain'
              AND deleted_at IS NULL
         ), 0)
   WHERE d.id = v_agenda_item_id;

  -- Para AFTER UPDATE com mudança de agenda_item_id (raro mas possível), também
  -- re-agrega o ponto antigo.
  IF TG_OP = 'UPDATE' AND OLD.assembly_agenda_item_id IS DISTINCT FROM NEW.assembly_agenda_item_id THEN
    UPDATE core.assembly_agenda_item d
       SET votes_in_favor = COALESCE((
             SELECT SUM(permillage_applied)
               FROM core.assembly_vote
              WHERE assembly_agenda_item_id = d.id
                AND vote = 'favor'
                AND deleted_at IS NULL
           ), 0),
           votes_against = COALESCE((
             SELECT SUM(permillage_applied)
               FROM core.assembly_vote
              WHERE assembly_agenda_item_id = d.id
                AND vote = 'against'
                AND deleted_at IS NULL
           ), 0),
           votes_abstain = COALESCE((
             SELECT SUM(permillage_applied)
               FROM core.assembly_vote
              WHERE assembly_agenda_item_id = d.id
                AND vote = 'abstain'
                AND deleted_at IS NULL
           ), 0)
     WHERE d.id = OLD.assembly_agenda_item_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: fn_block_closed_fiscal_year(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE OR REPLACE FUNCTION core.fn_block_closed_fiscal_year() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: fn_format_base36(integer, text, integer); Type: FUNCTION; Schema: core; Owner: -
--

CREATE OR REPLACE FUNCTION core.fn_format_base36(n integer, prefix text, min_width integer) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  alphabet text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  result text := '';
  remainder integer := n;
BEGIN
  IF n IS NULL OR n < 1 THEN
    RETURN NULL;
  END IF;
  IF prefix IS NULL OR prefix = '' THEN
    RETURN NULL;
  END IF;
  WHILE remainder > 0 LOOP
    result := substring(alphabet FROM (remainder % 36) + 1 FOR 1) || result;
    remainder := remainder / 36;
  END LOOP;
  RETURN prefix || lpad(result, min_width, '0');
END;
$$;


--
-- Name: fn_inspection_assign_code(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE OR REPLACE FUNCTION core.fn_inspection_assign_code() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_n integer;
BEGIN
  IF NEW.code IS NOT NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO core.inspection_code_counter (condominium_id, last_number, updated_at)
  VALUES (NEW.condominium_id, 1, now())
  ON CONFLICT (condominium_id)
  DO UPDATE SET
    last_number = core.inspection_code_counter.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_n;

  NEW.code := core.fn_format_base36(v_n, 'I', 3);
  RETURN NEW;
END;
$$;


--
-- Name: fn_pathology_assign_code(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE OR REPLACE FUNCTION core.fn_pathology_assign_code() RETURNS trigger
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


--
-- Name: fn_refacturation_validate(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE OR REPLACE FUNCTION core.fn_refacturation_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: fn_tenant_guard(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE OR REPLACE FUNCTION core.fn_tenant_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: fn_tenant_of(text, text); Type: FUNCTION; Schema: core; Owner: -
--

CREATE OR REPLACE FUNCTION core.fn_tenant_of(p_table text, p_id text) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $_$
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
$_$;


--
-- Name: fn_ticket_assign_code(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE OR REPLACE FUNCTION core.fn_ticket_assign_code() RETURNS trigger
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


--
-- Name: fn_charge_account(character varying, character varying, character varying, text); Type: FUNCTION; Schema: finance; Owner: -
--

CREATE OR REPLACE FUNCTION finance.fn_charge_account(p_kind character varying, p_nature character varying, p_charge_type character varying, p_account_id text DEFAULT NULL::text) RETURNS character varying
    LANGUAGE plpgsql STABLE
    AS $$
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


--
-- Name: fn_charge_ai(); Type: FUNCTION; Schema: finance; Owner: -
--

CREATE OR REPLACE FUNCTION finance.fn_charge_ai() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: fn_charge_amount_adjust_ledger(); Type: FUNCTION; Schema: finance; Owner: -
--

CREATE OR REPLACE FUNCTION finance.fn_charge_amount_adjust_ledger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: fn_charge_assign_code(); Type: FUNCTION; Schema: finance; Owner: -
--

CREATE OR REPLACE FUNCTION finance.fn_charge_assign_code() RETURNS trigger
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


--
-- Name: fn_charge_au(); Type: FUNCTION; Schema: finance; Owner: -
--

CREATE OR REPLACE FUNCTION finance.fn_charge_au() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: fn_charge_bu(); Type: FUNCTION; Schema: finance; Owner: -
--

CREATE OR REPLACE FUNCTION finance.fn_charge_bu() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: fn_charge_code_format(integer, text); Type: FUNCTION; Schema: finance; Owner: -
--

CREATE OR REPLACE FUNCTION finance.fn_charge_code_format(n integer, prefix text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  alphabet text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  result text := '';
  remainder integer := n;
  v_width integer;
  v_max integer;
BEGIN
  -- D (a pagar) usa 4 dígitos; R (a receber) mantém 5. `lpad` trunca acima da
  -- largura, por isso rejeitamos (NULL) n acima da capacidade de cada prefixo.
  IF prefix = 'D' THEN
    v_width := 4; v_max := 1679615;   -- 36^4 - 1
  ELSIF prefix = 'R' THEN
    v_width := 5; v_max := 60466175;  -- 36^5 - 1
  ELSE
    RETURN NULL;
  END IF;
  IF n IS NULL OR n < 1 OR n > v_max THEN
    RETURN NULL;
  END IF;
  WHILE remainder > 0 LOOP
    result := substring(alphabet FROM (remainder % 36) + 1 FOR 1) || result;
    remainder := remainder / 36;
  END LOOP;
  RETURN prefix || lpad(result, v_width, '0');
END;
$$;


--
-- Name: fn_charge_fcr_split(text, integer); Type: FUNCTION; Schema: finance; Owner: -
--

CREATE OR REPLACE FUNCTION finance.fn_charge_fcr_split(p_charge_id text, p_amount integer, OUT ord_part integer, OUT fcr_part integer) RETURNS record
    LANGUAGE plpgsql STABLE
    AS $$
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


--
-- Name: fn_counterparty_account(character varying, character varying); Type: FUNCTION; Schema: finance; Owner: -
--

CREATE OR REPLACE FUNCTION finance.fn_counterparty_account(p_kind character varying, p_charge_type character varying) RETURNS character varying
    LANGUAGE plpgsql STABLE
    AS $$
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


--
-- Name: fn_reject_ledger_modification(); Type: FUNCTION; Schema: finance; Owner: -
--

CREATE OR REPLACE FUNCTION finance.fn_reject_ledger_modification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION
    'finance.ledger é append-only (% rejected on %)',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Lançamentos contabilísticos não podem ser alterados nem '
                 'apagados. Para corrigir, regista um lançamento de regularização '
                 '(novo INSERT com entry_type específico).';
END;
$$;


--
-- Name: FUNCTION fn_reject_ledger_modification(); Type: COMMENT; Schema: finance; Owner: -
--

COMMENT ON FUNCTION finance.fn_reject_ledger_modification() IS 'Trigger function: rejeita UPDATE/DELETE/TRUNCATE em finance.ledger. Garantia contabilística - registos imutáveis depois de gravados.';


--
-- Name: fn_settlement_ai(); Type: FUNCTION; Schema: finance; Owner: -
--

CREATE OR REPLACE FUNCTION finance.fn_settlement_ai() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: fn_settlement_au(); Type: FUNCTION; Schema: finance; Owner: -
--

CREATE OR REPLACE FUNCTION finance.fn_settlement_au() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: fn_settlement_bi(); Type: FUNCTION; Schema: finance; Owner: -
--

CREATE OR REPLACE FUNCTION finance.fn_settlement_bi() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: nanoid(integer, text, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.nanoid(size integer DEFAULT 21, alphabet text DEFAULT '_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'::text, additionalbytesfactor double precision DEFAULT 1.6) RETURNS text
    LANGUAGE plpgsql PARALLEL SAFE
    AS $$
DECLARE
    alphabetArray  text[];
    alphabetLength int := 64;
    mask           int := 63;
    step           int := 34;
BEGIN
    IF size IS NULL OR size < 1 THEN
        RAISE EXCEPTION 'The size must be defined and greater than 0!';
    END IF;

    IF alphabet IS NULL OR length(alphabet) = 0 OR length(alphabet) > 255 THEN
        RAISE EXCEPTION 'The alphabet can''t be undefined, zero or bigger than 255 symbols!';
    END IF;

    IF additionalBytesFactor IS NULL OR additionalBytesFactor < 1 THEN
        RAISE EXCEPTION 'The additional bytes factor can''t be less than 1!';
    END IF;

    alphabetArray := regexp_split_to_array(alphabet, '');
    alphabetLength := array_length(alphabetArray, 1);
    mask := (2 << cast(floor(log(alphabetLength - 1) / log(2)) as int)) - 1;
    step := cast(ceil(additionalBytesFactor * mask * size / alphabetLength) AS int);

    IF step > 1024 THEN
        step := 1024; -- The step size % can''t be bigger then 1024!
    END IF;

    RETURN nanoid_optimized(size, alphabet, mask, step);
END
$$;


--
-- Name: nanoid_optimized(integer, text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.nanoid_optimized(size integer, alphabet text, mask integer, step integer) RETURNS text
    LANGUAGE plpgsql PARALLEL SAFE
    AS $$
DECLARE
    idBuilder      text := '';
    counter        int  := 0;
    bytes          bytea;
    alphabetIndex  int;
    alphabetArray  text[];
    alphabetLength int  := 64;
BEGIN
    alphabetArray := regexp_split_to_array(alphabet, '');
    alphabetLength := array_length(alphabetArray, 1);

    LOOP
        bytes := gen_random_bytes(step);
        FOR counter IN 0..step - 1
            LOOP
                alphabetIndex := (get_byte(bytes, counter) & mask) + 1;
                IF alphabetIndex <= alphabetLength THEN
                    idBuilder := idBuilder || alphabetArray[alphabetIndex];
                    IF length(idBuilder) = size THEN
                        RETURN idBuilder;
                    END IF;
                END IF;
            END LOOP;
    END LOOP;
END
$$;


SET default_tablespace = '';

--
-- Name: cdc_log; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.cdc_log (
    id bigint CONSTRAINT log_id_not_null NOT NULL,
    condominium_id text,
    actor jsonb,
    table_schema text CONSTRAINT log_table_schema_not_null NOT NULL,
    table_name text CONSTRAINT log_table_name_not_null NOT NULL,
    row_id text CONSTRAINT log_row_id_not_null NOT NULL,
    action character varying(20) CONSTRAINT log_action_not_null NOT NULL,
    diff jsonb,
    snapshot jsonb,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT log_created_at_not_null NOT NULL,
    CONSTRAINT cdc_log_action_check CHECK (((action)::text = ANY (ARRAY[('insert'::character varying)::text, ('update'::character varying)::text, ('delete'::character varying)::text]))),
    CONSTRAINT cdc_log_actor_object_check CHECK (((actor IS NULL) OR (jsonb_typeof(actor) = 'object'::text)))
)
PARTITION BY RANGE (created_at);


SET default_table_access_method = heap;

--
-- Name: cdc_log_2026; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.cdc_log_2026 (
    id bigint CONSTRAINT log_id_not_null NOT NULL,
    condominium_id text,
    actor jsonb,
    table_schema text CONSTRAINT log_table_schema_not_null NOT NULL,
    table_name text CONSTRAINT log_table_name_not_null NOT NULL,
    row_id text CONSTRAINT log_row_id_not_null NOT NULL,
    action character varying(20) CONSTRAINT log_action_not_null NOT NULL,
    diff jsonb,
    snapshot jsonb,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT log_created_at_not_null NOT NULL,
    CONSTRAINT cdc_log_action_check CHECK (((action)::text = ANY (ARRAY[('insert'::character varying)::text, ('update'::character varying)::text, ('delete'::character varying)::text]))),
    CONSTRAINT cdc_log_actor_object_check CHECK (((actor IS NULL) OR (jsonb_typeof(actor) = 'object'::text)))
);


--
-- Name: cdc_log_2027; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.cdc_log_2027 (
    id bigint CONSTRAINT log_id_not_null NOT NULL,
    condominium_id text,
    actor jsonb,
    table_schema text CONSTRAINT log_table_schema_not_null NOT NULL,
    table_name text CONSTRAINT log_table_name_not_null NOT NULL,
    row_id text CONSTRAINT log_row_id_not_null NOT NULL,
    action character varying(20) CONSTRAINT log_action_not_null NOT NULL,
    diff jsonb,
    snapshot jsonb,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT log_created_at_not_null NOT NULL,
    CONSTRAINT cdc_log_action_check CHECK (((action)::text = ANY (ARRAY[('insert'::character varying)::text, ('update'::character varying)::text, ('delete'::character varying)::text]))),
    CONSTRAINT cdc_log_actor_object_check CHECK (((actor IS NULL) OR (jsonb_typeof(actor) = 'object'::text)))
);


--
-- Name: cdc_log_2028; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.cdc_log_2028 (
    id bigint CONSTRAINT log_id_not_null NOT NULL,
    condominium_id text,
    actor jsonb,
    table_schema text CONSTRAINT log_table_schema_not_null NOT NULL,
    table_name text CONSTRAINT log_table_name_not_null NOT NULL,
    row_id text CONSTRAINT log_row_id_not_null NOT NULL,
    action character varying(20) CONSTRAINT log_action_not_null NOT NULL,
    diff jsonb,
    snapshot jsonb,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT log_created_at_not_null NOT NULL,
    CONSTRAINT cdc_log_action_check CHECK (((action)::text = ANY (ARRAY[('insert'::character varying)::text, ('update'::character varying)::text, ('delete'::character varying)::text]))),
    CONSTRAINT cdc_log_actor_object_check CHECK (((actor IS NULL) OR (jsonb_typeof(actor) = 'object'::text)))
);


--
-- Name: cdc_skip_list; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.cdc_skip_list (
    schema_name text CONSTRAINT skip_list_schema_name_not_null NOT NULL,
    table_name text CONSTRAINT skip_list_table_name_not_null NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT skip_list_created_at_not_null NOT NULL
);


--
-- Name: email_log; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.email_log (
    id bigint NOT NULL,
    category character varying(40) NOT NULL,
    recipient text NOT NULL,
    bcc text,
    subject text NOT NULL,
    condominium_id text,
    unit_id text,
    actor jsonb,
    status character varying(20) DEFAULT 'sent'::character varying NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    occupant_id text,
    body_html text,
    attachments jsonb,
    CONSTRAINT email_log_actor_object_check CHECK (((actor IS NULL) OR (jsonb_typeof(actor) = 'object'::text))),
    CONSTRAINT email_log_status_check CHECK (((status)::text = ANY (ARRAY[('sent'::character varying)::text, ('failed'::character varying)::text])))
)
PARTITION BY RANGE (created_at);


--
-- Name: email_log_2026; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.email_log_2026 (
    id bigint CONSTRAINT email_log_id_not_null NOT NULL,
    category character varying(40) CONSTRAINT email_log_category_not_null NOT NULL,
    recipient text CONSTRAINT email_log_recipient_not_null NOT NULL,
    bcc text,
    subject text CONSTRAINT email_log_subject_not_null NOT NULL,
    condominium_id text,
    unit_id text,
    actor jsonb,
    status character varying(20) DEFAULT 'sent'::character varying CONSTRAINT email_log_status_not_null NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT email_log_created_at_not_null NOT NULL,
    occupant_id text,
    body_html text,
    attachments jsonb,
    CONSTRAINT email_log_actor_object_check CHECK (((actor IS NULL) OR (jsonb_typeof(actor) = 'object'::text))),
    CONSTRAINT email_log_status_check CHECK (((status)::text = ANY (ARRAY[('sent'::character varying)::text, ('failed'::character varying)::text])))
);


--
-- Name: email_log_2027; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.email_log_2027 (
    id bigint CONSTRAINT email_log_id_not_null NOT NULL,
    category character varying(40) CONSTRAINT email_log_category_not_null NOT NULL,
    recipient text CONSTRAINT email_log_recipient_not_null NOT NULL,
    bcc text,
    subject text CONSTRAINT email_log_subject_not_null NOT NULL,
    condominium_id text,
    unit_id text,
    actor jsonb,
    status character varying(20) DEFAULT 'sent'::character varying CONSTRAINT email_log_status_not_null NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT email_log_created_at_not_null NOT NULL,
    occupant_id text,
    body_html text,
    attachments jsonb,
    CONSTRAINT email_log_actor_object_check CHECK (((actor IS NULL) OR (jsonb_typeof(actor) = 'object'::text))),
    CONSTRAINT email_log_status_check CHECK (((status)::text = ANY (ARRAY[('sent'::character varying)::text, ('failed'::character varying)::text])))
);


--
-- Name: email_log_2028; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.email_log_2028 (
    id bigint CONSTRAINT email_log_id_not_null NOT NULL,
    category character varying(40) CONSTRAINT email_log_category_not_null NOT NULL,
    recipient text CONSTRAINT email_log_recipient_not_null NOT NULL,
    bcc text,
    subject text CONSTRAINT email_log_subject_not_null NOT NULL,
    condominium_id text,
    unit_id text,
    actor jsonb,
    status character varying(20) DEFAULT 'sent'::character varying CONSTRAINT email_log_status_not_null NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT email_log_created_at_not_null NOT NULL,
    occupant_id text,
    body_html text,
    attachments jsonb,
    CONSTRAINT email_log_actor_object_check CHECK (((actor IS NULL) OR (jsonb_typeof(actor) = 'object'::text))),
    CONSTRAINT email_log_status_check CHECK (((status)::text = ANY (ARRAY[('sent'::character varying)::text, ('failed'::character varying)::text])))
);


--
-- Name: email_log_default; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.email_log_default (
    id bigint CONSTRAINT email_log_id_not_null NOT NULL,
    category character varying(40) CONSTRAINT email_log_category_not_null NOT NULL,
    recipient text CONSTRAINT email_log_recipient_not_null NOT NULL,
    bcc text,
    subject text CONSTRAINT email_log_subject_not_null NOT NULL,
    condominium_id text,
    unit_id text,
    actor jsonb,
    status character varying(20) DEFAULT 'sent'::character varying CONSTRAINT email_log_status_not_null NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT email_log_created_at_not_null NOT NULL,
    occupant_id text,
    body_html text,
    attachments jsonb,
    CONSTRAINT email_log_actor_object_check CHECK (((actor IS NULL) OR (jsonb_typeof(actor) = 'object'::text))),
    CONSTRAINT email_log_status_check CHECK (((status)::text = ANY (ARRAY[('sent'::character varying)::text, ('failed'::character varying)::text])))
);


--
-- Name: email_log_id_seq; Type: SEQUENCE; Schema: audit; Owner: -
--

ALTER TABLE audit.email_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME audit.email_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: log_id_seq; Type: SEQUENCE; Schema: audit; Owner: -
--

ALTER TABLE audit.cdc_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME audit.log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: assembly; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.assembly (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    type character varying(20) NOT NULL,
    scheduled_at timestamp with time zone NOT NULL,
    held_at timestamp with time zone,
    location character varying(255),
    convocation_sent_at timestamp with time zone,
    minutes_number character varying(50),
    minutes_document_id text,
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    deleted_by jsonb,
    president_occupant_id text,
    secretary_occupant_id text,
    minutes_signed_at date,
    convocation_round character varying(20) DEFAULT 'first'::character varying NOT NULL,
    second_convocation_at timestamp with time zone,
    introduction text,
    conclusion text,
    convocation_intro text,
    convocation_footer text,
    CONSTRAINT assembly_convocation_round_check CHECK (((convocation_round)::text = ANY (ARRAY[('first'::character varying)::text, ('second'::character varying)::text]))),
    CONSTRAINT assembly_minutes_signed_consistency CHECK ((((minutes_signed_at IS NULL) AND (president_occupant_id IS NULL) AND (secretary_occupant_id IS NULL)) OR ((minutes_signed_at IS NOT NULL) AND (president_occupant_id IS NOT NULL) AND (secretary_occupant_id IS NOT NULL)))),
    CONSTRAINT assembly_second_convocation_after_first CHECK (((second_convocation_at IS NULL) OR (second_convocation_at >= scheduled_at))),
    CONSTRAINT assembly_status_check CHECK (((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('scheduled'::character varying)::text, ('held'::character varying)::text, ('cancelled'::character varying)::text]))),
    CONSTRAINT assembly_type_check CHECK (((type)::text = ANY (ARRAY[('ordinary'::character varying)::text, ('extraordinary'::character varying)::text]))),
    CONSTRAINT core_assembly_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT core_assembly_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT core_assembly_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL)))
);


--
-- Name: assembly_agenda_item; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.assembly_agenda_item (
    id text DEFAULT public.nanoid(10) CONSTRAINT assembly_decision_id_not_null NOT NULL,
    assembly_id text CONSTRAINT assembly_decision_assembly_id_not_null NOT NULL,
    sequence integer CONSTRAINT assembly_decision_sequence_not_null NOT NULL,
    subject character varying(255) CONSTRAINT assembly_decision_subject_not_null NOT NULL,
    description text,
    item_type character varying(40),
    ref_type character varying(40),
    ref_id text,
    votes_in_favor numeric(8,3),
    votes_against numeric(8,3),
    votes_abstain numeric(8,3),
    approved boolean,
    notes text,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT assembly_decision_created_at_not_null NOT NULL,
    deleted_at timestamp with time zone,
    created_by jsonb DEFAULT '{}'::jsonb CONSTRAINT assembly_decision_created_by_not_null NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb CONSTRAINT assembly_decision_updated_by_not_null NOT NULL,
    deleted_by jsonb,
    vote_note text,
    CONSTRAINT assembly_agenda_item_ref_consistency CHECK ((((ref_type IS NULL) AND (ref_id IS NULL)) OR ((ref_type IS NOT NULL) AND (ref_id IS NOT NULL)))),
    CONSTRAINT assembly_agenda_item_ref_type_check CHECK (((ref_type IS NULL) OR ((ref_type)::text = 'budget'::text))),
    CONSTRAINT core_assembly_decision_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT core_assembly_decision_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT core_assembly_decision_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL)))
);


--
-- Name: assembly_attendee; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.assembly_attendee (
    id text DEFAULT public.nanoid(10) NOT NULL,
    assembly_id text NOT NULL,
    unit_id text NOT NULL,
    occupant_id text NOT NULL,
    permillage_at_meeting numeric(8,3) NOT NULL,
    is_proxy boolean DEFAULT false NOT NULL,
    proxy_holder_occupant_id text,
    arrived_at timestamp with time zone,
    left_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    deleted_by jsonb,
    proxy_holder_external_name text,
    convocation_round character varying(20) DEFAULT 'first'::character varying NOT NULL,
    CONSTRAINT assembly_attendee_convocation_round_check CHECK (((convocation_round)::text = ANY (ARRAY[('first'::character varying)::text, ('second'::character varying)::text]))),
    CONSTRAINT assembly_attendee_permillage_positive CHECK ((permillage_at_meeting > (0)::numeric)),
    CONSTRAINT assembly_attendee_proxy_consistency CHECK ((((is_proxy = false) AND (proxy_holder_occupant_id IS NULL) AND (proxy_holder_external_name IS NULL)) OR ((is_proxy = true) AND (((proxy_holder_occupant_id IS NOT NULL) AND (proxy_holder_external_name IS NULL)) OR ((proxy_holder_occupant_id IS NULL) AND (proxy_holder_external_name IS NOT NULL))))))
);


--
-- Name: assembly_convocation; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.assembly_convocation (
    id text DEFAULT public.nanoid(10) NOT NULL,
    assembly_id text NOT NULL,
    condominium_id text NOT NULL,
    trigger character varying(10) NOT NULL,
    recipients jsonb DEFAULT '[]'::jsonb NOT NULL,
    snapshot jsonb,
    sent_by jsonb NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    superseded_at timestamp with time zone,
    CONSTRAINT assembly_convocation_trigger_check CHECK (((trigger)::text = ANY (ARRAY[('individual'::character varying)::text, ('bulk'::character varying)::text])))
);


--
-- Name: TABLE assembly_convocation; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON TABLE core.assembly_convocation IS 'Audit trail (run-based) dos envios da convocatória da assembleia
   (ADR 0034). recipients[] tem status por destinatário
   (dedup por pessoa); snapshot guarda o que foi enviado (ordem do dia +
   textos + datas). Trigger individual ou bulk.';


--
-- Name: COLUMN assembly_convocation.superseded_at; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.assembly_convocation.superseded_at IS 'Quando a convocatória foi retificada (scheduled -> draft) este run deixa de
   contar para o cooldown / "último envio" / "última convocatória" - mas mantém-se
   para auditoria. NULL = run ativo. Ver update.ts (transição scheduled->draft) e
   convocation_history.ts.';


--
-- Name: assembly_vote; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.assembly_vote (
    id text DEFAULT public.nanoid(10) NOT NULL,
    assembly_agenda_item_id text CONSTRAINT assembly_vote_assembly_decision_id_not_null NOT NULL,
    unit_id text NOT NULL,
    vote character varying(20) NOT NULL,
    permillage_applied numeric(8,3) NOT NULL,
    occupant_id text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    deleted_by jsonb,
    CONSTRAINT assembly_vote_permillage_positive CHECK ((permillage_applied > (0)::numeric)),
    CONSTRAINT assembly_vote_value_check CHECK (((vote)::text = ANY (ARRAY[('favor'::character varying)::text, ('against'::character varying)::text, ('abstain'::character varying)::text])))
);


--
-- Name: attachment; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.attachment (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    entity_type character varying(30) NOT NULL,
    entity_id text NOT NULL,
    filename text NOT NULL,
    mime_type text NOT NULL,
    storage_key text NOT NULL,
    storage_etag text,
    file_size integer NOT NULL,
    file_sha256 text,
    created_by jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_by jsonb,
    deleted_at timestamp with time zone,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT attachment_entity_type_check CHECK (((entity_type)::text = ANY (ARRAY[('charge'::character varying)::text, ('ticket'::character varying)::text, ('inspection'::character varying)::text, ('assembly'::character varying)::text, ('insurance'::character varying)::text, ('document'::character varying)::text, ('pathology'::character varying)::text]))),
    CONSTRAINT core_attachment_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT core_attachment_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT core_attachment_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL)))
);


--
-- Name: billing_reminder; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.billing_reminder (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    unit_id text NOT NULL,
    trigger character varying(10) NOT NULL,
    recipients jsonb DEFAULT '[]'::jsonb NOT NULL,
    sent_by jsonb NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT billing_reminder_trigger_check CHECK (((trigger)::text = ANY (ARRAY[('individual'::character varying)::text, ('bulk'::character varying)::text])))
);


--
-- Name: TABLE billing_reminder; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON TABLE core.billing_reminder IS 'Audit trail de lembretes de cobrança enviados (ADR 0028). Cooldown
   14 dias avaliado em runtime contra MAX(sent_at). Trigger individual
   ou bulk. recipients[] tem status por destinatário.';


--
-- Name: budget; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.budget (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    year integer NOT NULL,
    status character varying(20) DEFAULT 'draft'::character varying,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    type character varying(20) DEFAULT 'principal'::character varying NOT NULL,
    parent_budget_id text,
    fcr_percentage numeric(5,2) DEFAULT 10.00 NOT NULL,
    approved_at timestamp with time zone,
    approved_by text,
    deleted_at timestamp with time zone,
    quotas_generated_at timestamp with time zone,
    created_by jsonb,
    updated_by jsonb,
    deleted_by jsonb,
    installments integer,
    first_competence_period date,
    CONSTRAINT budget_installments_check CHECK (((installments IS NULL) OR ((installments >= 1) AND (installments <= 120)))),
    CONSTRAINT budget_status_check CHECK (((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('approved'::character varying)::text, ('not_approved'::character varying)::text]))),
    CONSTRAINT budget_type_check CHECK (((type)::text = ANY (ARRAY[('principal'::character varying)::text, ('suplementar'::character varying)::text]))),
    CONSTRAINT budget_type_parent_check CHECK (((((type)::text = 'principal'::text) AND (parent_budget_id IS NULL)) OR (((type)::text = 'suplementar'::text) AND (parent_budget_id IS NOT NULL)))),
    CONSTRAINT core_budget_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT core_budget_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT core_budget_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL)))
);


--
-- Name: budget_line; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.budget_line (
    id text DEFAULT public.nanoid(10) NOT NULL,
    budget_id text NOT NULL,
    account_id text NOT NULL,
    annual_amount integer DEFAULT 0 NOT NULL,
    excluded_unit_categories text[] DEFAULT '{}'::text[],
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    deleted_by jsonb,
    CONSTRAINT core_budget_line_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT core_budget_line_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT core_budget_line_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL)))
);


--
-- Name: condominium; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.condominium (
    id text DEFAULT public.nanoid(6) NOT NULL,
    name character varying(255) NOT NULL,
    fiscal_number character varying(20),
    address text,
    city character varying(100),
    postal_code character varying(10),
    quota_day_of_month integer DEFAULT 1,
    fiscal_year_start_month integer DEFAULT 1,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone,
    email character varying(255),
    reconciled_through_date date,
    designation_type text DEFAULT 'condominium'::text NOT NULL,
    bcc_email text,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    deleted_by jsonb,
    reply_to_email text,
    billing_reminder_note text,
    insurance_reminder_note text,
    CONSTRAINT condominium_designation_type_check CHECK ((designation_type = ANY (ARRAY['building'::text, 'condominium'::text]))),
    CONSTRAINT condominiums_fiscal_month_check CHECK (((fiscal_year_start_month >= 1) AND (fiscal_year_start_month <= 12))),
    CONSTRAINT condominiums_quota_day_check CHECK (((quota_day_of_month >= 1) AND (quota_day_of_month <= 28))),
    CONSTRAINT core_condominium_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT core_condominium_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT core_condominium_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL)))
);


--
-- Name: document; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.document (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    title text NOT NULL,
    description text,
    category character varying(20) DEFAULT 'other'::character varying NOT NULL,
    is_public boolean DEFAULT false NOT NULL,
    published_at date DEFAULT CURRENT_DATE,
    created_by jsonb NOT NULL,
    updated_by jsonb,
    deleted_by jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT core_document_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT core_document_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT core_document_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL))),
    CONSTRAINT document_category_check CHECK (((category)::text = ANY (ARRAY['minutes'::text, 'regulation'::text, 'contract'::text, 'budget'::text, 'insurance'::text, 'plant'::text, 'other'::text])))
);


--
-- Name: COLUMN document.published_at; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.document.published_at IS 'Data oficial do documento (ata: data da assembleia; contrato: data de assinatura). NULLABLE - alguns documentos (regulamento, plantas) não têm data oficial. UI fallback: "Sem data oficial".';


--
-- Name: inspection; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.inspection (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    category character varying(20) NOT NULL,
    description text NOT NULL,
    last_done_date date,
    valid_until date NOT NULL,
    notify_days_before integer DEFAULT 30 NOT NULL,
    notes text,
    created_by jsonb NOT NULL,
    updated_by jsonb,
    deleted_by jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    code character varying(10),
    supplier_id text,
    CONSTRAINT core_inspection_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT core_inspection_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT core_inspection_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL))),
    CONSTRAINT inspection_category_check CHECK (((category)::text = ANY (ARRAY[('fire_extinguisher'::character varying)::text, ('fire_detection'::character varying)::text, ('elevator'::character varying)::text, ('gas'::character varying)::text, ('electricity'::character varying)::text, ('lightning_rod'::character varying)::text, ('hvac'::character varying)::text, ('pool'::character varying)::text, ('antenna'::character varying)::text, ('other'::character varying)::text]))),
    CONSTRAINT inspection_code_format_check CHECK (((code IS NULL) OR ((code)::text ~ '^I[0-9A-Z]{3,}$'::text))),
    CONSTRAINT inspection_notify_days_check CHECK (((notify_days_before >= 0) AND (notify_days_before <= 365)))
);


--
-- Name: inspection_code_counter; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.inspection_code_counter (
    condominium_id text NOT NULL,
    last_number integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inspection_code_counter_positive CHECK ((last_number >= 0))
);


--
-- Name: insurance_policy; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.insurance_policy (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    unit_id text NOT NULL,
    valid_from date NOT NULL,
    valid_to date NOT NULL,
    policy_number text,
    insurer text,
    ocr_extracted jsonb,
    ocr_confidence character varying(20),
    status character varying(20) DEFAULT 'pending_review'::character varying NOT NULL,
    confirmed_by jsonb,
    confirmed_at timestamp with time zone,
    rejected_by jsonb,
    rejected_at timestamp with time zone,
    rejected_reason text,
    uploaded_by jsonb NOT NULL,
    updated_by jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_by jsonb,
    approved_at timestamp with time zone,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    presumed_at timestamp with time zone,
    superseded_at timestamp with time zone,
    coverage_amount_cents integer,
    renewed_from_id text,
    evidence_source character varying(10),
    CONSTRAINT core_insurance_policy_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT core_insurance_policy_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL))),
    CONSTRAINT insurance_policy_evidence_source_check CHECK (((evidence_source IS NULL) OR ((evidence_source)::text = ANY (ARRAY[('unit'::character varying)::text, ('admin'::character varying)::text])))),
    CONSTRAINT insurance_policy_status_check CHECK (((status)::text = ANY (ARRAY['pending_review'::text, 'active'::text, 'rejected'::text, 'superseded'::text])))
);


--
-- Name: COLUMN insurance_policy.presumed_at; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.insurance_policy.presumed_at IS 'Timestamp set quando admin cria a linha via botão "renovar" sem evidência ainda. UI mostra badge "sem evidência (presumida)" enquanto attachment_count = 0. Nunca limpa - é facto histórico (ver ADR 0016).';


--
-- Name: COLUMN insurance_policy.superseded_at; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.insurance_policy.superseded_at IS 'Timestamp set quando esta vigência é substituída por uma nova (R2 supersede). Acompanha status=''superseded''.';


--
-- Name: COLUMN insurance_policy.coverage_amount_cents; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.insurance_policy.coverage_amount_cents IS 'Capital segurado em cêntimos. NULL quando admin/condómino/OCR não conseguiu extrair.';


--
-- Name: COLUMN insurance_policy.renewed_from_id; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.insurance_policy.renewed_from_id IS 'Linhagem de renovacao: apolice predecessora imediata. NULL em uploads de raiz. ON DELETE RESTRICT impede quebrar a cadeia.';


--
-- Name: COLUMN insurance_policy.evidence_source; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.insurance_policy.evidence_source IS 'Origem da evidencia, gravada na criacao: NULL criada sem documento, unit submetido no portal pela fracao, admin entregue a administracao fora do portal.';


--
-- Name: insurance_reminder; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.insurance_reminder (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    unit_id text NOT NULL,
    trigger character varying(20) NOT NULL,
    recipients jsonb DEFAULT '[]'::jsonb NOT NULL,
    sent_by jsonb NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT core_insurance_reminder_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT insurance_reminder_trigger_check CHECK (((trigger)::text = ANY (ARRAY['individual'::text, 'bulk'::text, 'renewal_evidence'::text])))
);


--
-- Name: invite_token; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.invite_token (
    token text NOT NULL,
    user_id text NOT NULL,
    purpose character varying(20) NOT NULL,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT core_invite_token_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT invite_token_purpose_check CHECK (((purpose)::text = ANY (ARRAY[('invite'::character varying)::text, ('reset'::character varying)::text])))
);


--
-- Name: manager; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.manager (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    user_id text NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    deleted_by jsonb,
    CONSTRAINT core_manager_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT core_manager_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT core_manager_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL)))
);


--
-- Name: occupant; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.occupant (
    id text DEFAULT public.nanoid(10) NOT NULL,
    user_id text,
    name character varying(255) NOT NULL,
    email character varying(255),
    nif character varying(20),
    phone character varying(30),
    condominium_id text NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone,
    created_by jsonb,
    updated_by jsonb,
    deleted_by jsonb,
    receive_receipt_emails boolean DEFAULT true NOT NULL,
    first_login_at timestamp with time zone,
    last_login_at timestamp with time zone,
    last_login_ip inet,
    last_login_user_agent text,
    person_type character varying(20) DEFAULT 'singular'::character varying NOT NULL,
    CONSTRAINT core_occupant_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT core_occupant_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT core_occupant_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL))),
    CONSTRAINT occupant_person_type_check CHECK (((person_type)::text = ANY (ARRAY[('singular'::character varying)::text, ('collective'::character varying)::text])))
);


--
-- Name: pathology; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.pathology (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    code character varying(10),
    title character varying(255) NOT NULL,
    description text,
    category character varying(20) NOT NULL,
    status character varying(30) DEFAULT 'draft'::character varying NOT NULL,
    affects_common_area boolean DEFAULT false NOT NULL,
    resolution_notes text,
    dismissed_reason text,
    detected_at date DEFAULT CURRENT_DATE NOT NULL,
    resolved_at date,
    dismissed_at date,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    deleted_by jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT pathology_category_check CHECK (((category)::text = ANY (ARRAY[('crack'::character varying)::text, ('infiltration'::character varying)::text, ('humidity'::character varying)::text, ('efflorescence'::character varying)::text, ('detachment'::character varying)::text, ('corrosion'::character varying)::text, ('mould'::character varying)::text, ('structural'::character varying)::text, ('other'::character varying)::text]))),
    CONSTRAINT pathology_code_format CHECK (((code IS NULL) OR ((code)::text ~ '^P[0-9A-Z]{3,}$'::text))),
    CONSTRAINT pathology_dismissed_reason_required CHECK ((((status)::text <> 'dismissed'::text) OR ((dismissed_reason IS NOT NULL) AND (dismissed_at IS NOT NULL)))),
    CONSTRAINT pathology_resolved_at_required CHECK ((((status)::text <> 'resolved'::text) OR (resolved_at IS NOT NULL))),
    CONSTRAINT pathology_status_check CHECK (((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('identified'::character varying)::text, ('awaiting_quotes'::character varying)::text, ('quote_approved'::character varying)::text, ('awaiting_repair_start'::character varying)::text, ('in_repair'::character varying)::text, ('resolved'::character varying)::text, ('dismissed'::character varying)::text])))
);


--
-- Name: pathology_code_counter; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.pathology_code_counter (
    condominium_id text NOT NULL,
    last_number integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pathology_code_counter_positive CHECK ((last_number >= 0))
);


--
-- Name: TABLE pathology_code_counter; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON TABLE core.pathology_code_counter IS 'Sequência atómica para pathology.code per-condomínio. Pattern ADR 0023. Trigger fn_pathology_assign_code em components/017 faz UPSERT atómico.';


--
-- Name: pathology_unit; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.pathology_unit (
    pathology_id text NOT NULL,
    unit_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_plan; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.payment_plan (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    unit_id text NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    notes text,
    end_date date,
    ended_at timestamp with time zone,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    deleted_by jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    internal_notes text,
    CONSTRAINT payment_plan_ended_at_consistency CHECK (((((status)::text = 'active'::text) AND (ended_at IS NULL)) OR (((status)::text <> 'active'::text) AND (ended_at IS NOT NULL)))),
    CONSTRAINT payment_plan_has_note CHECK (((NULLIF(btrim(notes), ''::text) IS NOT NULL) OR (NULLIF(btrim(internal_notes), ''::text) IS NOT NULL))),
    CONSTRAINT payment_plan_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('completed'::character varying)::text, ('broken'::character varying)::text, ('cancelled'::character varying)::text])))
);


--
-- Name: TABLE payment_plan; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON TABLE core.payment_plan IS 'Plano de pagamento por fração (informativo, com histórico). ADR 0039. Sem efeito no ledger; só nota + filtro. 1 active por fração.';


--
-- Name: COLUMN payment_plan.notes; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.payment_plan.notes IS 'Nota partilhada: sai no email de lembrete de cobranca enviado a fracao.';


--
-- Name: COLUMN payment_plan.internal_notes; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.payment_plan.internal_notes IS 'Nota interna: so a administracao a ve, nunca sai em emails.';


--
-- Name: quota_generation_run; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.quota_generation_run (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    budget_id text NOT NULL,
    through_date date NOT NULL,
    charges_created integer DEFAULT 0 NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT core_quota_generation_run_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL)))
);


--
-- Name: recurring_generation_run; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.recurring_generation_run (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    through_date date NOT NULL,
    templates_generated integer DEFAULT 0 NOT NULL,
    charges_created integer DEFAULT 0 NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT core_recurring_generation_run_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL)))
);


--
-- Name: recurring_template; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.recurring_template (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    kind character varying(20) NOT NULL,
    description character varying(255) NOT NULL,
    amount integer NOT NULL,
    account_id text,
    supplier_id text,
    contract_id text,
    unit_id text,
    interval_type character varying(20) NOT NULL,
    day_of_month integer,
    start_date date NOT NULL,
    end_date date,
    next_run_date date NOT NULL,
    last_generated_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    deleted_by jsonb,
    payment_method character varying(20) DEFAULT 'manual'::character varying NOT NULL,
    CONSTRAINT core_recurring_template_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT core_recurring_template_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT core_recurring_template_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL))),
    CONSTRAINT recurring_template_amount_check CHECK ((amount > 0)),
    CONSTRAINT recurring_template_day_check CHECK (((day_of_month IS NULL) OR ((day_of_month >= 1) AND (day_of_month <= 28)))),
    CONSTRAINT recurring_template_interval_check CHECK (((interval_type)::text = ANY (ARRAY['monthly'::text, 'bimonthly'::text, 'quarterly'::text, 'semiannual'::text, 'annual'::text]))),
    CONSTRAINT recurring_template_kind_check CHECK (((kind)::text = ANY (ARRAY[('receivable'::character varying)::text, ('payable'::character varying)::text]))),
    CONSTRAINT recurring_template_payment_method_check CHECK (((payment_method)::text = ANY (ARRAY[('manual'::character varying)::text, ('direct_debit'::character varying)::text, ('auto_transfer'::character varying)::text])))
);


--
-- Name: supplier; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.supplier (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    name character varying(255) NOT NULL,
    nif character varying(20),
    contact_name character varying(255),
    contact_email character varying(255),
    contact_phone character varying(50),
    account_id text,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by jsonb,
    updated_by jsonb,
    deleted_by jsonb,
    match_keywords text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT core_supplier_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT core_supplier_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT core_supplier_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL)))
);


--
-- Name: ticket; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.ticket (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    title text NOT NULL,
    description text,
    category character varying(30) NOT NULL,
    priority character varying(10) DEFAULT 'normal'::character varying NOT NULL,
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    unit_id text,
    location text,
    resolved_at timestamp with time zone,
    resolution_notes text,
    created_by jsonb NOT NULL,
    updated_by jsonb,
    deleted_by jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    code character varying(10) NOT NULL,
    pathology_id text,
    visibility character varying(20) DEFAULT 'admin_only'::character varying NOT NULL,
    reported_by_occupant_id text,
    CONSTRAINT core_ticket_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT core_ticket_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT core_ticket_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL))),
    CONSTRAINT ticket_category_check CHECK (((category)::text = ANY (ARRAY['elevator'::text, 'lighting'::text, 'plumbing'::text, 'hvac'::text, 'common_area'::text, 'facade'::text, 'parking'::text, 'garden'::text, 'security'::text, 'cleaning'::text, 'other'::text]))),
    CONSTRAINT ticket_code_format_check CHECK (((code IS NULL) OR ((code)::text ~ '^T[0-9A-Z]{3,}$'::text))),
    CONSTRAINT ticket_priority_check CHECK (((priority)::text = ANY (ARRAY[('low'::character varying)::text, ('normal'::character varying)::text, ('high'::character varying)::text, ('urgent'::character varying)::text]))),
    CONSTRAINT ticket_status_check CHECK (((status)::text = ANY (ARRAY[('open'::character varying)::text, ('in_progress'::character varying)::text, ('resolved'::character varying)::text, ('closed'::character varying)::text]))),
    CONSTRAINT ticket_visibility_check CHECK ((((visibility)::text = ANY (ARRAY[('admin_only'::character varying)::text, ('admin_unit'::character varying)::text, ('public'::character varying)::text])) AND (((visibility)::text <> 'admin_unit'::text) OR (unit_id IS NOT NULL))))
);


--
-- Name: COLUMN ticket.reported_by_occupant_id; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.ticket.reported_by_occupant_id IS 'Ocupante que reportou pelo portal. Destinatario dos emails de interacao (comentario publico do admin, mudanca de estado). NULL nas ocorrencias criadas pelo admin - sem reporter nao ha notificacao do lado da fracao.';


--
-- Name: ticket_code_counter; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.ticket_code_counter (
    condominium_id text NOT NULL,
    last_number integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_code_counter_positive CHECK ((last_number >= 0))
);


--
-- Name: ticket_comment; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.ticket_comment (
    id text DEFAULT public.nanoid(10) NOT NULL,
    ticket_id text NOT NULL,
    condominium_id text NOT NULL,
    comment text NOT NULL,
    is_internal boolean DEFAULT false NOT NULL,
    status_from character varying(20),
    status_to character varying(20),
    created_by jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT core_ticket_comment_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT core_ticket_comment_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL)))
);


--
-- Name: unit; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.unit (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    designation character varying(50) NOT NULL,
    floor character varying(20),
    permillage numeric(7,3) NOT NULL,
    description text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    door character varying(20),
    block character varying(50),
    unit_type character varying(20) DEFAULT 'residential'::character varying,
    deleted_at timestamp with time zone,
    created_by jsonb,
    updated_by jsonb,
    deleted_by jsonb,
    identifier text GENERATED ALWAYS AS (NULLIF(TRIM(BOTH ' '::text FROM ((
CASE
    WHEN (NULLIF((block)::text, ''::text) IS NOT NULL) THEN ('Bloco '::text || (block)::text)
    ELSE ''::text
END ||
CASE
    WHEN ((NULLIF((block)::text, ''::text) IS NOT NULL) AND ((((unit_type)::text = 'commercial'::text) AND (NULLIF((door)::text, ''::text) IS NOT NULL)) OR (NULLIF((floor)::text, ''::text) IS NOT NULL) OR (NULLIF((door)::text, ''::text) IS NOT NULL))) THEN ' - '::text
    ELSE ''::text
END) ||
CASE
    WHEN (((unit_type)::text = 'commercial'::text) AND (NULLIF((door)::text, ''::text) IS NOT NULL)) THEN ('Loja '::text || (door)::text)
    ELSE TRIM(BOTH ' '::text FROM ((
    CASE
        WHEN (NULLIF((floor)::text, ''::text) IS NOT NULL) THEN ((floor)::text ||
        CASE
            WHEN ((floor)::text ~ '^\d+$'::text) THEN 'º'::text
            ELSE ''::text
        END)
        ELSE ''::text
    END || ' '::text) || COALESCE(NULLIF((door)::text, ''::text), ''::text)))
END)), ''::text)) STORED,
    match_keywords text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT core_unit_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT core_unit_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT core_unit_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL))),
    CONSTRAINT unit_type_check CHECK (((unit_type)::text = ANY (ARRAY['residential'::text, 'commercial'::text])))
);


--
-- Name: unit_occupant; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.unit_occupant (
    id text DEFAULT public.nanoid(10) NOT NULL,
    unit_id text NOT NULL,
    occupant_id text NOT NULL,
    relationship_type character varying(20) DEFAULT 'owner'::character varying NOT NULL,
    start_date date DEFAULT CURRENT_DATE NOT NULL,
    end_date date,
    created_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    deleted_by jsonb,
    CONSTRAINT core_unit_occupant_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT core_unit_occupant_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT core_unit_occupant_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL))),
    CONSTRAINT unit_occupant_relationship_check CHECK (((relationship_type)::text = ANY (ARRAY['owner'::text, 'tenant'::text, 'resident'::text])))
);


--
-- Name: user; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core."user" (
    id text DEFAULT public.nanoid(10) NOT NULL,
    email character varying(255),
    name character varying(255),
    role character varying(20),
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone,
    password_hash text,
    password_changed_at timestamp with time zone,
    failed_login_attempts integer DEFAULT 0 NOT NULL,
    last_failed_login_at timestamp with time zone,
    theme text,
    last_login_at timestamp with time zone,
    first_login_at timestamp with time zone,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    deleted_by jsonb,
    terms_acknowledged_at timestamp with time zone,
    CONSTRAINT core_user_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT core_user_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT core_user_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL))),
    CONSTRAINT user_failed_login_attempts_check CHECK ((failed_login_attempts >= 0)),
    CONSTRAINT user_theme_check CHECK (((theme IS NULL) OR (theme = ANY (ARRAY['light'::text, 'dark'::text])))),
    CONSTRAINT users_role_check CHECK (((role IS NULL) OR ((role)::text = 'super'::text)))
);


--
-- Name: COLUMN "user".terms_acknowledged_at; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core."user".terms_acknowledged_at IS 'Timestamp do clique em "OK, entendi" no aviso de privacidade do portal. NULL = ainda não viu/aceitou. Per-user (não per-fração).';


--
-- Name: vw_unit_insurance_status; Type: VIEW; Schema: core; Owner: -
--

CREATE VIEW core.vw_unit_insurance_status AS
 SELECT u.id AS unit_id,
    u.condominium_id,
    u.designation,
    u.identifier,
    COALESCE(p.policies, '[]'::jsonb) AS policies,
    r.last_reminder_at,
    r.last_renewal_evidence_at,
    COALESCE(em.has_email, false) AS has_occupant_with_email,
    COALESCE(occs.occupants, '[]'::jsonb) AS occupants
   FROM ((((core.unit u
     LEFT JOIN LATERAL ( SELECT jsonb_agg(jsonb_build_object('id', ip.id, 'condominiumId', ip.condominium_id, 'unitId', ip.unit_id, 'validFrom', ip.valid_from, 'validTo', ip.valid_to, 'policyNumber', ip.policy_number, 'insurer', ip.insurer, 'ocrExtracted', ip.ocr_extracted, 'ocrConfidence', ip.ocr_confidence, 'status', ip.status, 'confirmedBy', ip.confirmed_by, 'confirmedAt', ip.confirmed_at, 'approvedBy', ip.approved_by, 'approvedAt', ip.approved_at, 'rejectedBy', ip.rejected_by, 'rejectedAt', ip.rejected_at, 'rejectedReason', ip.rejected_reason, 'uploadedBy', ip.uploaded_by, 'updatedBy', ip.updated_by, 'createdAt', ip.created_at, 'updatedAt', ip.updated_at, 'presumedAt', ip.presumed_at, 'evidenceSource', ip.evidence_source, 'supersededAt', ip.superseded_at, 'coverageAmountCents', ip.coverage_amount_cents, 'renewedFromId', ip.renewed_from_id, 'primaryAttachment', ( SELECT jsonb_build_object('id', a.id, 'mimeType', a.mime_type, 'filename', a.filename) AS jsonb_build_object
                   FROM core.attachment a
                  WHERE (((a.entity_type)::text = 'insurance'::text) AND (a.entity_id = ip.id) AND (a.deleted_at IS NULL))
                  ORDER BY a.created_at DESC
                 LIMIT 1), 'attachmentCount', ( SELECT count(*) AS count
                   FROM core.attachment a
                  WHERE (((a.entity_type)::text = 'insurance'::text) AND (a.entity_id = ip.id) AND (a.deleted_at IS NULL))), 'attachments', COALESCE(( SELECT jsonb_agg(jsonb_build_object('id', a.id, 'mimeType', a.mime_type, 'filename', a.filename) ORDER BY a.created_at DESC) AS jsonb_agg
                   FROM core.attachment a
                  WHERE (((a.entity_type)::text = 'insurance'::text) AND (a.entity_id = ip.id) AND (a.deleted_at IS NULL))), '[]'::jsonb)) ORDER BY ip.created_at DESC) AS policies
           FROM core.insurance_policy ip
          WHERE (ip.unit_id = u.id)) p ON (true))
     LEFT JOIN LATERAL ( SELECT max(insurance_reminder.sent_at) FILTER (WHERE ((insurance_reminder.trigger)::text <> 'renewal_evidence'::text)) AS last_reminder_at,
            max(insurance_reminder.sent_at) FILTER (WHERE ((insurance_reminder.trigger)::text = 'renewal_evidence'::text)) AS last_renewal_evidence_at
           FROM core.insurance_reminder
          WHERE (insurance_reminder.unit_id = u.id)) r ON (true))
     LEFT JOIN LATERAL ( SELECT (EXISTS ( SELECT 1
                   FROM (core.unit_occupant uo
                     JOIN core.occupant o ON ((o.id = uo.occupant_id)))
                  WHERE ((uo.unit_id = u.id) AND (uo.deleted_at IS NULL) AND (uo.start_date <= CURRENT_DATE) AND ((uo.end_date IS NULL) OR (uo.end_date >= CURRENT_DATE)) AND (o.deleted_at IS NULL) AND (o.email IS NOT NULL) AND ((o.email)::text <> ''::text)))) AS has_email) em ON (true))
     LEFT JOIN LATERAL ( SELECT jsonb_agg(jsonb_build_object('name', o.name, 'relationshipType', uo.relationship_type) ORDER BY
                CASE uo.relationship_type
                    WHEN 'owner'::text THEN 0
                    WHEN 'tenant'::text THEN 1
                    WHEN 'resident'::text THEN 2
                    ELSE 9
                END, o.name) AS occupants
           FROM (core.unit_occupant uo
             JOIN core.occupant o ON ((o.id = uo.occupant_id)))
          WHERE ((uo.unit_id = u.id) AND (uo.deleted_at IS NULL) AND (uo.start_date <= CURRENT_DATE) AND ((uo.end_date IS NULL) OR (uo.end_date >= CURRENT_DATE)) AND (o.deleted_at IS NULL))) occs ON (true))
  WHERE ((u.deleted_at IS NULL) AND (u.is_active = true));


--
-- Name: charge; Type: TABLE; Schema: finance; Owner: -
--

CREATE TABLE finance.charge (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    unit_id text,
    scope character varying(20) DEFAULT 'unit'::character varying NOT NULL,
    nature character varying(6) NOT NULL,
    charge_type character varying(40) NOT NULL,
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    issue_date date DEFAULT CURRENT_DATE NOT NULL,
    due_date date,
    competence_period date NOT NULL,
    original_amount integer NOT NULL,
    settled_amount integer DEFAULT 0 NOT NULL,
    open_amount integer NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    document_number character varying(50),
    source_type character varying(40),
    source_id text,
    created_by jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    kind character varying(20) DEFAULT 'receivable'::character varying NOT NULL,
    account_id text,
    expected_amount integer DEFAULT 0 NOT NULL,
    amount integer DEFAULT 0 NOT NULL,
    supplier_id text,
    contract_id text,
    recurring_template_id text,
    invoice_number character varying(100),
    updated_by jsonb,
    note text,
    payment_method character varying(20) DEFAULT 'manual'::character varying NOT NULL,
    code character varying(10),
    budget_id text,
    CONSTRAINT charge_kind_check CHECK (((kind)::text = ANY (ARRAY[('receivable'::character varying)::text, ('payable'::character varying)::text]))),
    CONSTRAINT charge_nature_check CHECK (((nature)::text = ANY (ARRAY[('debit'::character varying)::text, ('credit'::character varying)::text]))),
    CONSTRAINT charge_open_amount_check CHECK ((open_amount >= 0)),
    CONSTRAINT charge_original_amount_check CHECK ((original_amount > 0)),
    CONSTRAINT charge_settled_amount_check CHECK ((settled_amount >= 0)),
    CONSTRAINT charge_status_check CHECK (((status)::text = ANY (ARRAY[('open'::character varying)::text, ('partial'::character varying)::text, ('paid'::character varying)::text, ('overdue'::character varying)::text, ('cancelled'::character varying)::text, ('disputed'::character varying)::text]))),
    CONSTRAINT finance_charge_code_format_check CHECK (((code IS NULL) OR ((code)::text ~ '^(D[0-9A-Z]{4}|R[0-9A-Z]{5})$'::text))),
    CONSTRAINT finance_charge_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT finance_charge_payment_method_check CHECK (((payment_method)::text = ANY (ARRAY[('manual'::character varying)::text, ('direct_debit'::character varying)::text, ('auto_transfer'::character varying)::text]))),
    CONSTRAINT finance_charge_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL)))
);


--
-- Name: COLUMN charge.note; Type: COMMENT; Schema: finance; Owner: -
--

COMMENT ON COLUMN finance.charge.note IS 'Nota interna do admin sobre a cobrança. NUNCA exposta no portal do condómino - `description` é o texto público.';


--
-- Name: COLUMN charge.budget_id; Type: COMMENT; Schema: finance; Owner: -
--

COMMENT ON COLUMN finance.charge.budget_id IS 'Orçamento a que a despesa foi imputada (etiqueta manual). NULL = inferido pela rubrica + ano no relatório por Ata.';


--
-- Name: balance_supplier; Type: VIEW; Schema: finance; Owner: -
--

CREATE VIEW finance.balance_supplier AS
 SELECT condominium_id,
    supplier_id,
    sum(
        CASE
            WHEN (((nature)::text = 'credit'::text) AND (competence_period <= CURRENT_DATE)) THEN open_amount
            ELSE 0
        END) AS current_open_credit,
    sum(
        CASE
            WHEN ((nature)::text = 'debit'::text) THEN open_amount
            ELSE 0
        END) AS current_open_debit,
    (sum(
        CASE
            WHEN (((nature)::text = 'credit'::text) AND (competence_period <= CURRENT_DATE)) THEN open_amount
            ELSE 0
        END) - sum(
        CASE
            WHEN ((nature)::text = 'debit'::text) THEN open_amount
            ELSE 0
        END)) AS current_net_balance,
    sum(
        CASE
            WHEN (((nature)::text = 'credit'::text) AND (competence_period > CURRENT_DATE)) THEN open_amount
            ELSE 0
        END) AS future_open_credit,
    sum(
        CASE
            WHEN ((nature)::text = 'credit'::text) THEN open_amount
            ELSE 0
        END) AS total_open_credit,
    sum(
        CASE
            WHEN ((nature)::text = 'debit'::text) THEN open_amount
            ELSE 0
        END) AS total_open_debit,
    (sum(
        CASE
            WHEN ((nature)::text = 'credit'::text) THEN open_amount
            ELSE 0
        END) - sum(
        CASE
            WHEN ((nature)::text = 'debit'::text) THEN open_amount
            ELSE 0
        END)) AS total_net_balance,
    sum(
        CASE
            WHEN (((nature)::text = 'credit'::text) AND ((status)::text = 'overdue'::text)) THEN open_amount
            ELSE 0
        END) AS overdue_amount,
    count(*) FILTER (WHERE (((nature)::text = 'credit'::text) AND ((status)::text = 'overdue'::text))) AS overdue_count,
    min(due_date) FILTER (WHERE (((nature)::text = 'credit'::text) AND ((status)::text = 'overdue'::text))) AS oldest_overdue_date
   FROM finance.charge c
  WHERE (((kind)::text = 'payable'::text) AND (supplier_id IS NOT NULL) AND ((status)::text <> 'cancelled'::text))
  GROUP BY condominium_id, supplier_id;


--
-- Name: VIEW balance_supplier; Type: COMMENT; Schema: finance; Owner: -
--

COMMENT ON VIEW finance.balance_supplier IS 'Saldo por (condomínio, fornecedor) considerando apenas payables com supplier_id. Payables sem supplier_id (ex.: honorários) ficam fora - consultar finance.charge. net_balance positivo = condomínio deve ao fornecedor.';


--
-- Name: balance_unit; Type: VIEW; Schema: finance; Owner: -
--

CREATE VIEW finance.balance_unit AS
 SELECT condominium_id,
    unit_id,
    sum(
        CASE
            WHEN (((nature)::text = 'debit'::text) AND (competence_period <= CURRENT_DATE)) THEN open_amount
            ELSE 0
        END) AS current_open_debit,
    sum(
        CASE
            WHEN ((nature)::text = 'credit'::text) THEN open_amount
            ELSE 0
        END) AS current_open_credit,
    (sum(
        CASE
            WHEN ((nature)::text = 'credit'::text) THEN open_amount
            ELSE 0
        END) - sum(
        CASE
            WHEN (((nature)::text = 'debit'::text) AND (competence_period <= CURRENT_DATE)) THEN open_amount
            ELSE 0
        END)) AS current_net_balance,
    sum(
        CASE
            WHEN (((nature)::text = 'debit'::text) AND (competence_period > CURRENT_DATE)) THEN open_amount
            ELSE 0
        END) AS future_open_debit,
    sum(
        CASE
            WHEN ((nature)::text = 'debit'::text) THEN open_amount
            ELSE 0
        END) AS total_open_debit,
    sum(
        CASE
            WHEN ((nature)::text = 'credit'::text) THEN open_amount
            ELSE 0
        END) AS total_open_credit,
    (sum(
        CASE
            WHEN ((nature)::text = 'credit'::text) THEN open_amount
            ELSE 0
        END) - sum(
        CASE
            WHEN ((nature)::text = 'debit'::text) THEN open_amount
            ELSE 0
        END)) AS total_net_balance,
    sum(
        CASE
            WHEN (((nature)::text = 'debit'::text) AND ((status)::text = 'overdue'::text)) THEN open_amount
            ELSE 0
        END) AS overdue_amount,
    count(*) FILTER (WHERE (((nature)::text = 'debit'::text) AND ((status)::text = 'overdue'::text))) AS overdue_count,
    min(due_date) FILTER (WHERE (((nature)::text = 'debit'::text) AND ((status)::text = 'overdue'::text))) AS oldest_overdue_date
   FROM finance.charge c
  WHERE (((kind)::text = 'receivable'::text) AND (unit_id IS NOT NULL) AND ((status)::text <> 'cancelled'::text))
  GROUP BY condominium_id, unit_id;


--
-- Name: VIEW balance_unit; Type: COMMENT; Schema: finance; Owner: -
--

COMMENT ON VIEW finance.balance_unit IS 'Saldo por (condomínio, fração) considerando apenas receivables. current_*: débitos com competence ≤ hoje + créditos disponíveis. future_*: quotas geradas com competence > hoje. total_*: tudo (visão "se nada mudar"). net_balance positivo = fração tem crédito.';


--
-- Name: bank_account; Type: TABLE; Schema: finance; Owner: -
--

CREATE TABLE finance.bank_account (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    bank_name character varying(100) NOT NULL,
    iban character varying(34),
    account_name character varying(255),
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    csv_config jsonb DEFAULT '{"columns": {"date": 0, "amount": 3, "balance": 4, "value_date": 1, "description": 2}, "delimiter": ";", "skip_rows": 1, "date_format": "dd/mm/yyyy"}'::jsonb,
    opening_balance integer DEFAULT 0 NOT NULL,
    opening_balance_date date,
    deleted_at timestamp with time zone,
    opening_balance_ordinary_cents integer DEFAULT 0 NOT NULL,
    opening_balance_fcr_cents integer DEFAULT 0 NOT NULL,
    kind character varying(10) DEFAULT 'bank'::character varying NOT NULL,
    account_holder text,
    is_quota_payment boolean DEFAULT false NOT NULL,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    deleted_by jsonb,
    CONSTRAINT bank_account_kind_check CHECK (((kind)::text = ANY (ARRAY[('bank'::character varying)::text, ('cash'::character varying)::text]))),
    CONSTRAINT bank_account_opening_split_matches CHECK (((opening_balance = (opening_balance_ordinary_cents + opening_balance_fcr_cents)) OR ((opening_balance = 0) AND (opening_balance_ordinary_cents = 0) AND (opening_balance_fcr_cents = 0)))),
    CONSTRAINT bank_account_quota_only_for_bank CHECK ((NOT (is_quota_payment AND ((kind)::text <> 'bank'::text)))),
    CONSTRAINT finance_bank_account_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT finance_bank_account_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT finance_bank_account_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL)))
);


--
-- Name: bank_import_batch; Type: TABLE; Schema: finance; Owner: -
--

CREATE TABLE finance.bank_import_batch (
    id text DEFAULT public.nanoid(10) NOT NULL,
    bank_account_id text NOT NULL,
    condominium_id text NOT NULL,
    imported_at timestamp with time zone DEFAULT now(),
    imported_by text,
    filename character varying(255),
    rows_total integer DEFAULT 0,
    rows_imported integer DEFAULT 0,
    rows_skipped integer DEFAULT 0,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT finance_bank_import_batch_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT finance_bank_import_batch_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL)))
);


--
-- Name: bank_transaction; Type: TABLE; Schema: finance; Owner: -
--

CREATE TABLE finance.bank_transaction (
    id text DEFAULT public.nanoid(10) NOT NULL,
    bank_account_id text NOT NULL,
    condominium_id text NOT NULL,
    transaction_date date NOT NULL,
    value_date date,
    amount integer NOT NULL,
    description text,
    balance_after integer,
    is_reconciled boolean DEFAULT false,
    import_hash character varying(64),
    created_at timestamp with time zone DEFAULT now(),
    notes text,
    import_batch_id text,
    operation_date date,
    status character varying(20) DEFAULT 'unreconciled'::character varying,
    match_status character varying(20) DEFAULT 'pending'::character varying,
    match_unit_ids text[] DEFAULT '{}'::text[],
    match_expense_ids text[] DEFAULT '{}'::text[],
    reversed_by_transaction_id text,
    created_by jsonb,
    updated_by jsonb,
    reversal_reason text,
    CONSTRAINT bank_tx_match_status_check CHECK (((match_status)::text = ANY (ARRAY[('pending'::character varying)::text, ('pre_selected'::character varying)::text, ('blocked'::character varying)::text]))),
    CONSTRAINT bank_tx_status_check CHECK (((status)::text = ANY (ARRAY[('unreconciled'::character varying)::text, ('partial'::character varying)::text, ('reconciled'::character varying)::text, ('ignored'::character varying)::text, ('reversed'::character varying)::text]))),
    CONSTRAINT finance_bank_transaction_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT finance_bank_transaction_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL)))
);


--
-- Name: charge_code_counter; Type: TABLE; Schema: finance; Owner: -
--

CREATE TABLE finance.charge_code_counter (
    condominium_id text NOT NULL,
    last_number integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    prefix character varying(1) NOT NULL,
    CONSTRAINT finance_charge_code_counter_positive CHECK ((last_number >= 0)),
    CONSTRAINT finance_charge_code_counter_prefix_check CHECK (((prefix)::text = ANY (ARRAY[('D'::character varying)::text, ('R'::character varying)::text])))
);


--
-- Name: TABLE charge_code_counter; Type: COMMENT; Schema: finance; Owner: -
--

COMMENT ON TABLE finance.charge_code_counter IS 'Sequência atómica para charge.code per-condomínio. Atualizada via UPSERT durante INSERT de charges. Ver ADR 0023.';


--
-- Name: chart_of_account; Type: TABLE; Schema: finance; Owner: -
--

CREATE TABLE finance.chart_of_account (
    id text DEFAULT public.nanoid(10) NOT NULL,
    code character varying(20) NOT NULL,
    condominium_id text,
    name character varying(150) NOT NULL,
    type character varying(20) NOT NULL,
    parent_code character varying(20),
    is_active boolean DEFAULT true NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    deleted_by jsonb,
    CONSTRAINT chart_of_account_type_check CHECK (((type)::text = ANY (ARRAY[('asset'::character varying)::text, ('liability'::character varying)::text, ('equity'::character varying)::text, ('revenue'::character varying)::text, ('expense'::character varying)::text]))),
    CONSTRAINT finance_chart_of_account_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT finance_chart_of_account_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT finance_chart_of_account_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL)))
);


--
-- Name: fcr_transfer; Type: TABLE; Schema: finance; Owner: -
--

CREATE TABLE finance.fcr_transfer (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    direction character varying(12) NOT NULL,
    amount_cents integer NOT NULL,
    transfer_date date NOT NULL,
    reason text NOT NULL,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fcr_transfer_amount_check CHECK ((amount_cents > 0)),
    CONSTRAINT fcr_transfer_direction_check CHECK (((direction)::text = ANY (ARRAY[('to_fcr'::character varying)::text, ('to_ordinary'::character varying)::text])))
);


--
-- Name: TABLE fcr_transfer; Type: COMMENT; Schema: finance; Owner: -
--

COMMENT ON TABLE finance.fcr_transfer IS 'Reclassificação entre bolsa ordinária (121) e bolsa FCR (122). Append-only: corrigir = transferência inversa.';


--
-- Name: fiscal_year; Type: TABLE; Schema: finance; Owner: -
--

CREATE TABLE finance.fiscal_year (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    year integer NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    closed_at timestamp with time zone,
    closed_by text,
    closed_assembly_id text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT finance_fiscal_year_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT finance_fiscal_year_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL))),
    CONSTRAINT fiscal_year_status_check CHECK (((status)::text = ANY (ARRAY[('open'::character varying)::text, ('closing'::character varying)::text, ('closed'::character varying)::text])))
);


--
-- Name: ledger; Type: TABLE; Schema: finance; Owner: -
--

CREATE TABLE finance.ledger (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    unit_id text,
    entity_type character varying(20) DEFAULT 'unit'::character varying NOT NULL,
    entry_date date DEFAULT CURRENT_DATE NOT NULL,
    entry_type character varying(40) NOT NULL,
    account_code character varying(40) NOT NULL,
    direction character varying(6) NOT NULL,
    amount integer NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    ref_type character varying(40),
    ref_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ledger_amount_check CHECK ((amount > 0)),
    CONSTRAINT ledger_direction_check CHECK (((direction)::text = ANY (ARRAY[('debit'::character varying)::text, ('credit'::character varying)::text])))
);


--
-- Name: receipt; Type: TABLE; Schema: finance; Owner: -
--

CREATE TABLE finance.receipt (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    unit_id text NOT NULL,
    bank_transaction_id text NOT NULL,
    year integer NOT NULL,
    sequence integer NOT NULL,
    number text GENERATED ALWAYS AS ((((year)::text || '/'::text) || lpad((sequence)::text, 5, '0'::text))) STORED,
    amount_cents integer NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    issued_by jsonb NOT NULL,
    voided_at timestamp with time zone,
    voided_by jsonb,
    voided_reason text,
    condominium_snapshot jsonb NOT NULL,
    unit_snapshot jsonb NOT NULL,
    recipients_snapshot jsonb NOT NULL,
    lines_snapshot jsonb NOT NULL,
    bank_tx_snapshot jsonb NOT NULL,
    storage_key text NOT NULL,
    storage_etag text,
    file_size integer,
    file_sha256 text,
    email_sent_to jsonb DEFAULT '[]'::jsonb NOT NULL,
    email_last_attempt_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    recipients_access jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT finance_receipt_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT finance_receipt_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL))),
    CONSTRAINT receipt_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT receipt_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT receipt_void_consistency CHECK ((((voided_at IS NULL) AND (voided_reason IS NULL) AND (voided_by IS NULL)) OR ((voided_at IS NOT NULL) AND (voided_reason IS NOT NULL) AND (voided_by IS NOT NULL)))),
    CONSTRAINT receipt_year_check CHECK (((year >= 2000) AND (year <= 2100)))
);


--
-- Name: receipt_skip; Type: TABLE; Schema: finance; Owner: -
--

CREATE TABLE finance.receipt_skip (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    bank_transaction_id text NOT NULL,
    unit_id text NOT NULL,
    reason text,
    skipped_by jsonb NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by jsonb,
    deleted_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT finance_receipt_skip_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT finance_receipt_skip_deleted_by_object_check CHECK (((jsonb_typeof(deleted_by) = 'object'::text) OR (deleted_by IS NULL))),
    CONSTRAINT finance_receipt_skip_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL)))
);


--
-- Name: settlement; Type: TABLE; Schema: finance; Owner: -
--

CREATE TABLE finance.settlement (
    id text DEFAULT public.nanoid(10) NOT NULL,
    condominium_id text NOT NULL,
    unit_id text,
    debit_charge_id text,
    credit_charge_id text,
    bank_transaction_id text,
    amount integer NOT NULL,
    settlement_date date DEFAULT CURRENT_DATE NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    settlement_type character varying(30) NOT NULL,
    reversed_by text,
    reversed_at timestamp with time zone,
    reversal_reason text,
    notes text DEFAULT ''::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    debit_ref_type text,
    debit_ref_id text,
    credit_ref_type text,
    credit_ref_id text,
    updated_by jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT finance_settlement_created_by_object_check CHECK (((jsonb_typeof(created_by) = 'object'::text) OR (created_by IS NULL))),
    CONSTRAINT finance_settlement_updated_by_object_check CHECK (((jsonb_typeof(updated_by) = 'object'::text) OR (updated_by IS NULL))),
    CONSTRAINT settlement_amount_check CHECK ((amount > 0)),
    CONSTRAINT settlement_credit_check CHECK (((((settlement_type)::text = 'bank_reconciliation'::text) AND (bank_transaction_id IS NOT NULL) AND (((debit_charge_id IS NOT NULL) AND (credit_charge_id IS NULL)) OR ((debit_charge_id IS NULL) AND (credit_charge_id IS NOT NULL)))) OR (((settlement_type)::text = 'charge_offset'::text) AND (credit_charge_id IS NOT NULL) AND (debit_charge_id IS NOT NULL) AND (bank_transaction_id IS NULL)) OR (((settlement_type)::text = 'bank_deposit_credit'::text) AND (bank_transaction_id IS NOT NULL) AND (credit_charge_id IS NOT NULL) AND (debit_charge_id IS NULL)))),
    CONSTRAINT settlement_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('reversed'::character varying)::text]))),
    CONSTRAINT settlement_type_check CHECK (((settlement_type)::text = ANY (ARRAY[('bank_reconciliation'::character varying)::text, ('charge_offset'::character varying)::text, ('bank_deposit_credit'::character varying)::text])))
);


--
-- Name: v_bank_balance; Type: VIEW; Schema: finance; Owner: -
--

CREATE VIEW finance.v_bank_balance AS
 SELECT condominium_id,
    (COALESCE(sum(
        CASE
            WHEN ((account_code)::text = '121'::text) THEN
            CASE
                WHEN ((direction)::text = 'debit'::text) THEN amount
                ELSE (- amount)
            END
            ELSE 0
        END), (0)::bigint))::integer AS ordinary_cents,
    (COALESCE(sum(
        CASE
            WHEN ((account_code)::text = '122'::text) THEN
            CASE
                WHEN ((direction)::text = 'debit'::text) THEN amount
                ELSE (- amount)
            END
            ELSE 0
        END), (0)::bigint))::integer AS fcr_cents,
    (COALESCE(sum(
        CASE
            WHEN ((account_code)::text = ANY ((ARRAY['121'::character varying, '122'::character varying])::text[])) THEN
            CASE
                WHEN ((direction)::text = 'debit'::text) THEN amount
                ELSE (- amount)
            END
            ELSE 0
        END), (0)::bigint))::integer AS total_cents
   FROM finance.ledger
  WHERE ((account_code)::text = ANY ((ARRAY['121'::character varying, '122'::character varying])::text[]))
  GROUP BY condominium_id;


--
-- Name: v_budget_quota_map; Type: VIEW; Schema: finance; Owner: -
--

CREATE VIEW finance.v_budget_quota_map AS
 WITH total_pm AS (
         SELECT unit.condominium_id,
            sum((unit.permillage)::numeric) AS total
           FROM core.unit
          WHERE ((unit.is_active = true) AND (unit.deleted_at IS NULL))
          GROUP BY unit.condominium_id
        ), budget_annual AS (
         SELECT b.id AS budget_id,
            b.condominium_id,
            b.year,
            b.type,
            b.status,
            (b.fcr_percentage)::numeric AS fcr_percentage,
            b.quotas_generated_at,
            COALESCE(b.installments, 12) AS divisor,
            (COALESCE(sum(bl.annual_amount), (0)::bigint))::integer AS annual_ordinary
           FROM (core.budget b
             LEFT JOIN core.budget_line bl ON (((bl.budget_id = b.id) AND (bl.deleted_at IS NULL))))
          WHERE (b.deleted_at IS NULL)
          GROUP BY b.id, b.condominium_id, b.year, b.type, b.status, b.fcr_percentage, b.quotas_generated_at, b.installments
        ), per_unit AS (
         SELECT ba.budget_id,
            ba.condominium_id,
            ba.year,
            ba.type AS budget_type,
            ba.status AS budget_status,
            ba.quotas_generated_at,
            ba.fcr_percentage,
            ba.annual_ordinary,
            ba.divisor,
            u.id AS unit_id,
            u.designation AS unit_designation,
            (u.permillage)::numeric AS unit_permillage,
            tp.total AS total_permillage,
            (round(((((ba.annual_ordinary)::numeric / (ba.divisor)::numeric) * (u.permillage)::numeric) / tp.total)))::integer AS monthly_base_cents
           FROM ((budget_annual ba
             JOIN core.unit u ON (((u.condominium_id = ba.condominium_id) AND (u.is_active = true) AND (u.deleted_at IS NULL))))
             JOIN total_pm tp ON ((tp.condominium_id = ba.condominium_id)))
        )
 SELECT budget_id,
    condominium_id,
    year,
    budget_type,
    budget_status,
    quotas_generated_at,
    fcr_percentage,
    unit_id,
    unit_designation,
    unit_permillage,
    total_permillage,
    annual_ordinary,
    monthly_base_cents,
    (round((((monthly_base_cents)::numeric * fcr_percentage) / (100)::numeric)))::integer AS monthly_fcr_cents,
    (((monthly_base_cents)::numeric + round((((monthly_base_cents)::numeric * fcr_percentage) / (100)::numeric))))::integer AS monthly_total_cents,
    ((((monthly_base_cents)::numeric + round((((monthly_base_cents)::numeric * fcr_percentage) / (100)::numeric))) * (divisor)::numeric))::integer AS annual_total_cents
   FROM per_unit;


--
-- Name: v_unit_balance; Type: VIEW; Schema: finance; Owner: -
--

CREATE VIEW finance.v_unit_balance AS
 SELECT c.condominium_id,
    c.unit_id,
    (COALESCE(sum(
        CASE
            WHEN (((c.nature)::text = 'debit'::text) AND ((c.status)::text = ANY ((ARRAY['open'::character varying, 'partial'::character varying, 'overdue'::character varying])::text[]))) THEN c.open_amount
            ELSE 0
        END), (0)::bigint))::integer AS open_debt_cents,
    (COALESCE(sum(
        CASE
            WHEN (((c.nature)::text = 'credit'::text) AND ((c.status)::text = ANY ((ARRAY['open'::character varying, 'partial'::character varying, 'overdue'::character varying])::text[]))) THEN c.open_amount
            ELSE 0
        END), (0)::bigint))::integer AS open_credit_cents,
    (COALESCE(sum(
        CASE
            WHEN (((c.nature)::text = 'debit'::text) AND ((c.status)::text = ANY ((ARRAY['open'::character varying, 'partial'::character varying, 'overdue'::character varying])::text[])) AND (c.due_date IS NOT NULL) AND (cd.reconciled_through_date IS NOT NULL) AND (c.due_date <= cd.reconciled_through_date)) THEN c.open_amount
            ELSE 0
        END), (0)::bigint))::integer AS overdue_debt_cents,
    (COALESCE(sum(
        CASE
            WHEN ((c.status)::text = ANY ((ARRAY['open'::character varying, 'partial'::character varying, 'overdue'::character varying])::text[])) THEN
            CASE
                WHEN ((c.nature)::text = 'debit'::text) THEN c.open_amount
                WHEN ((c.nature)::text = 'credit'::text) THEN (- c.open_amount)
                ELSE 0
            END
            ELSE 0
        END), (0)::bigint))::integer AS net_cents
   FROM (finance.charge c
     LEFT JOIN core.condominium cd ON ((cd.id = c.condominium_id)))
  WHERE ((c.unit_id IS NOT NULL) AND ((c.scope)::text = 'unit'::text) AND ((c.status)::text <> 'cancelled'::text))
  GROUP BY c.condominium_id, c.unit_id, cd.reconciled_through_date;


--
-- Name: vw_pending_receipts; Type: VIEW; Schema: finance; Owner: -
--

CREATE VIEW finance.vw_pending_receipts AS
 SELECT bt.condominium_id,
    bt.id AS bank_transaction_id,
    COALESCE(s.unit_id, c.unit_id) AS unit_id,
    bt.transaction_date AS payment_date,
    bt.description AS bank_tx_description,
    bt.amount AS bank_tx_amount,
    bt.bank_account_id,
    (sum(s.amount))::integer AS recipient_amount,
    (count(s.id))::integer AS settlements_count
   FROM ((finance.bank_transaction bt
     JOIN finance.settlement s ON (((s.bank_transaction_id = bt.id) AND ((s.status)::text = 'active'::text))))
     LEFT JOIN finance.charge c ON (((c.id = COALESCE(s.debit_charge_id, s.credit_charge_id)) AND ((c.status)::text <> 'cancelled'::text))))
  WHERE ((bt.amount > 0) AND ((COALESCE(bt.status, 'unreconciled'::character varying))::text <> ALL ((ARRAY['reversed'::character varying, 'ignored'::character varying])::text[])) AND ((s.settlement_type)::text = ANY ((ARRAY['bank_reconciliation'::character varying, 'bank_deposit_credit'::character varying])::text[])) AND (COALESCE(s.unit_id, c.unit_id) IS NOT NULL) AND (NOT (EXISTS ( SELECT 1
           FROM finance.receipt r
          WHERE ((r.bank_transaction_id = bt.id) AND (r.unit_id = COALESCE(s.unit_id, c.unit_id)) AND (r.voided_at IS NULL))))) AND (NOT (EXISTS ( SELECT 1
           FROM finance.receipt_skip rs
          WHERE ((rs.bank_transaction_id = bt.id) AND (rs.unit_id = COALESCE(s.unit_id, c.unit_id)) AND (rs.deleted_at IS NULL))))))
  GROUP BY bt.condominium_id, bt.id, COALESCE(s.unit_id, c.unit_id), bt.transaction_date, bt.description, bt.amount, bt.bank_account_id;


--
-- Name: vw_receipt_emit_data; Type: VIEW; Schema: finance; Owner: -
--

CREATE VIEW finance.vw_receipt_emit_data AS
 SELECT bt.condominium_id,
    bt.id AS bank_transaction_id,
    COALESCE(s.unit_id, c.unit_id) AS unit_id,
    bt.transaction_date AS payment_date,
    bt.description AS bank_tx_description,
    bt.amount AS bank_tx_amount,
    ba.bank_name AS bank_account_bank_name,
    ba.account_name AS bank_account_name,
    ba.iban AS bank_account_iban,
    ba.kind AS bank_account_kind,
    s.id AS settlement_id,
    s.amount AS settlement_amount,
    s.settlement_type,
    c.id AS charge_id,
    c.charge_type,
    c.description AS charge_description,
    c.competence_period AS charge_competence_period,
    c.original_amount AS charge_original_amount,
    c.nature AS charge_nature
   FROM (((finance.bank_transaction bt
     JOIN finance.settlement s ON (((s.bank_transaction_id = bt.id) AND ((s.status)::text = 'active'::text))))
     LEFT JOIN finance.charge c ON (((c.id = COALESCE(s.debit_charge_id, s.credit_charge_id)) AND ((c.status)::text <> 'cancelled'::text))))
     LEFT JOIN finance.bank_account ba ON ((ba.id = bt.bank_account_id)))
  WHERE (((s.settlement_type)::text = ANY ((ARRAY['bank_reconciliation'::character varying, 'bank_deposit_credit'::character varying])::text[])) AND (COALESCE(s.unit_id, c.unit_id) IS NOT NULL));


--
-- Name: cdc_log_2026; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.cdc_log ATTACH PARTITION audit.cdc_log_2026 FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');


--
-- Name: cdc_log_2027; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.cdc_log ATTACH PARTITION audit.cdc_log_2027 FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2028-01-01 00:00:00+00');


--
-- Name: cdc_log_2028; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.cdc_log ATTACH PARTITION audit.cdc_log_2028 FOR VALUES FROM ('2028-01-01 00:00:00+00') TO ('2029-01-01 00:00:00+00');


--
-- Name: email_log_2026; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.email_log ATTACH PARTITION audit.email_log_2026 FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');


--
-- Name: email_log_2027; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.email_log ATTACH PARTITION audit.email_log_2027 FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2028-01-01 00:00:00+00');


--
-- Name: email_log_2028; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.email_log ATTACH PARTITION audit.email_log_2028 FOR VALUES FROM ('2028-01-01 00:00:00+00') TO ('2029-01-01 00:00:00+00');


--
-- Name: email_log_default; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.email_log ATTACH PARTITION audit.email_log_default DEFAULT;


--
-- Name: email_log email_log_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.email_log
    ADD CONSTRAINT email_log_pkey PRIMARY KEY (id, created_at);


--
-- Name: email_log_2026 email_log_2026_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.email_log_2026
    ADD CONSTRAINT email_log_2026_pkey PRIMARY KEY (id, created_at);


--
-- Name: email_log_2027 email_log_2027_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.email_log_2027
    ADD CONSTRAINT email_log_2027_pkey PRIMARY KEY (id, created_at);


--
-- Name: email_log_2028 email_log_2028_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.email_log_2028
    ADD CONSTRAINT email_log_2028_pkey PRIMARY KEY (id, created_at);


--
-- Name: email_log_default email_log_default_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.email_log_default
    ADD CONSTRAINT email_log_default_pkey PRIMARY KEY (id, created_at);


--
-- Name: cdc_log log_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.cdc_log
    ADD CONSTRAINT log_pkey PRIMARY KEY (id, created_at);


--
-- Name: cdc_log_2026 log_2026_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.cdc_log_2026
    ADD CONSTRAINT log_2026_pkey PRIMARY KEY (id, created_at);


--
-- Name: cdc_log_2027 log_2027_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.cdc_log_2027
    ADD CONSTRAINT log_2027_pkey PRIMARY KEY (id, created_at);


--
-- Name: cdc_log_2028 log_2028_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.cdc_log_2028
    ADD CONSTRAINT log_2028_pkey PRIMARY KEY (id, created_at);


--
-- Name: cdc_skip_list skip_list_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.cdc_skip_list
    ADD CONSTRAINT skip_list_pkey PRIMARY KEY (schema_name, table_name);


--
-- Name: manager admin_condominium_user_unique; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.manager
    ADD CONSTRAINT admin_condominium_user_unique UNIQUE (condominium_id, user_id);


--
-- Name: manager admin_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.manager
    ADD CONSTRAINT admin_pkey PRIMARY KEY (id);


--
-- Name: assembly_agenda_item assembly_agenda_item_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.assembly_agenda_item
    ADD CONSTRAINT assembly_agenda_item_pkey PRIMARY KEY (id);


--
-- Name: assembly_agenda_item assembly_agenda_item_unique; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.assembly_agenda_item
    ADD CONSTRAINT assembly_agenda_item_unique UNIQUE (assembly_id, sequence);


--
-- Name: assembly_attendee assembly_attendee_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.assembly_attendee
    ADD CONSTRAINT assembly_attendee_pkey PRIMARY KEY (id);


--
-- Name: assembly_convocation assembly_convocation_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.assembly_convocation
    ADD CONSTRAINT assembly_convocation_pkey PRIMARY KEY (id);


--
-- Name: assembly assembly_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.assembly
    ADD CONSTRAINT assembly_pkey PRIMARY KEY (id);


--
-- Name: assembly_vote assembly_vote_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.assembly_vote
    ADD CONSTRAINT assembly_vote_pkey PRIMARY KEY (id);


--
-- Name: attachment attachment_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.attachment
    ADD CONSTRAINT attachment_pkey PRIMARY KEY (id);


--
-- Name: attachment attachment_storage_key_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.attachment
    ADD CONSTRAINT attachment_storage_key_key UNIQUE (storage_key);


--
-- Name: billing_reminder billing_reminder_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.billing_reminder
    ADD CONSTRAINT billing_reminder_pkey PRIMARY KEY (id);


--
-- Name: budget_line budget_lines_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.budget_line
    ADD CONSTRAINT budget_lines_pkey PRIMARY KEY (id);


--
-- Name: budget budgets_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.budget
    ADD CONSTRAINT budgets_pkey PRIMARY KEY (id);


--
-- Name: condominium condominiums_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.condominium
    ADD CONSTRAINT condominiums_pkey PRIMARY KEY (id);


--
-- Name: document document_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.document
    ADD CONSTRAINT document_pkey PRIMARY KEY (id);


--
-- Name: inspection_code_counter inspection_code_counter_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.inspection_code_counter
    ADD CONSTRAINT inspection_code_counter_pkey PRIMARY KEY (condominium_id);


--
-- Name: inspection inspection_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.inspection
    ADD CONSTRAINT inspection_pkey PRIMARY KEY (id);


--
-- Name: insurance_policy insurance_policy_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.insurance_policy
    ADD CONSTRAINT insurance_policy_pkey PRIMARY KEY (id);


--
-- Name: insurance_reminder insurance_reminder_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.insurance_reminder
    ADD CONSTRAINT insurance_reminder_pkey PRIMARY KEY (id);


--
-- Name: invite_token invite_token_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.invite_token
    ADD CONSTRAINT invite_token_pkey PRIMARY KEY (token);


--
-- Name: occupant occupants_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.occupant
    ADD CONSTRAINT occupants_pkey PRIMARY KEY (id);


--
-- Name: pathology_code_counter pathology_code_counter_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.pathology_code_counter
    ADD CONSTRAINT pathology_code_counter_pkey PRIMARY KEY (condominium_id);


--
-- Name: pathology pathology_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.pathology
    ADD CONSTRAINT pathology_pkey PRIMARY KEY (id);


--
-- Name: pathology_unit pathology_unit_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.pathology_unit
    ADD CONSTRAINT pathology_unit_pkey PRIMARY KEY (pathology_id, unit_id);


--
-- Name: payment_plan payment_plan_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.payment_plan
    ADD CONSTRAINT payment_plan_pkey PRIMARY KEY (id);


--
-- Name: quota_generation_run quota_generation_run_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.quota_generation_run
    ADD CONSTRAINT quota_generation_run_pkey PRIMARY KEY (id);


--
-- Name: recurring_generation_run recurring_generation_run_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.recurring_generation_run
    ADD CONSTRAINT recurring_generation_run_pkey PRIMARY KEY (id);


--
-- Name: recurring_template recurring_template_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.recurring_template
    ADD CONSTRAINT recurring_template_pkey PRIMARY KEY (id);


--
-- Name: supplier suppliers_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.supplier
    ADD CONSTRAINT suppliers_pkey PRIMARY KEY (id);


--
-- Name: ticket_code_counter ticket_code_counter_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.ticket_code_counter
    ADD CONSTRAINT ticket_code_counter_pkey PRIMARY KEY (condominium_id);


--
-- Name: ticket_comment ticket_comment_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.ticket_comment
    ADD CONSTRAINT ticket_comment_pkey PRIMARY KEY (id);


--
-- Name: ticket ticket_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.ticket
    ADD CONSTRAINT ticket_pkey PRIMARY KEY (id);


--
-- Name: unit_occupant unit_occupants_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.unit_occupant
    ADD CONSTRAINT unit_occupants_pkey PRIMARY KEY (id);


--
-- Name: unit_occupant unit_occupants_unit_occupant_unique; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.unit_occupant
    ADD CONSTRAINT unit_occupants_unit_occupant_unique UNIQUE (unit_id, occupant_id, relationship_type);


--
-- Name: unit units_condominium_id_designation_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.unit
    ADD CONSTRAINT units_condominium_id_designation_key UNIQUE (condominium_id, designation);


--
-- Name: unit units_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.unit
    ADD CONSTRAINT units_pkey PRIMARY KEY (id);


--
-- Name: user users_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core."user"
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: bank_account bank_accounts_pkey; Type: CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.bank_account
    ADD CONSTRAINT bank_accounts_pkey PRIMARY KEY (id);


--
-- Name: bank_import_batch bank_import_batches_pkey; Type: CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.bank_import_batch
    ADD CONSTRAINT bank_import_batches_pkey PRIMARY KEY (id);


--
-- Name: bank_transaction bank_transactions_pkey; Type: CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.bank_transaction
    ADD CONSTRAINT bank_transactions_pkey PRIMARY KEY (id);


--
-- Name: bank_transaction bank_tx_import_hash_unique; Type: CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.bank_transaction
    ADD CONSTRAINT bank_tx_import_hash_unique UNIQUE (bank_account_id, import_hash);


--
-- Name: charge charge_pkey; Type: CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.charge
    ADD CONSTRAINT charge_pkey PRIMARY KEY (id);


--
-- Name: chart_of_account chart_of_account_pkey; Type: CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.chart_of_account
    ADD CONSTRAINT chart_of_account_pkey PRIMARY KEY (id);


--
-- Name: fcr_transfer fcr_transfer_pkey; Type: CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.fcr_transfer
    ADD CONSTRAINT fcr_transfer_pkey PRIMARY KEY (id);


--
-- Name: charge_code_counter finance_charge_code_counter_pkey; Type: CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.charge_code_counter
    ADD CONSTRAINT finance_charge_code_counter_pkey PRIMARY KEY (condominium_id, prefix);


--
-- Name: fiscal_year fiscal_year_pkey; Type: CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.fiscal_year
    ADD CONSTRAINT fiscal_year_pkey PRIMARY KEY (id);


--
-- Name: fiscal_year fiscal_year_unique; Type: CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.fiscal_year
    ADD CONSTRAINT fiscal_year_unique UNIQUE (condominium_id, year);


--
-- Name: ledger ledger_pkey; Type: CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.ledger
    ADD CONSTRAINT ledger_pkey PRIMARY KEY (id);


--
-- Name: receipt receipt_pkey; Type: CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.receipt
    ADD CONSTRAINT receipt_pkey PRIMARY KEY (id);


--
-- Name: receipt receipt_seq_unique; Type: CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.receipt
    ADD CONSTRAINT receipt_seq_unique UNIQUE (condominium_id, year, sequence);


--
-- Name: receipt_skip receipt_skip_pkey; Type: CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.receipt_skip
    ADD CONSTRAINT receipt_skip_pkey PRIMARY KEY (id);


--
-- Name: receipt receipt_storage_unique; Type: CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.receipt
    ADD CONSTRAINT receipt_storage_unique UNIQUE (storage_key);


--
-- Name: settlement settlement_pkey; Type: CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.settlement
    ADD CONSTRAINT settlement_pkey PRIMARY KEY (id);


--
-- Name: idx_email_log_condo; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX idx_email_log_condo ON ONLY audit.email_log USING btree (condominium_id, created_at DESC) WHERE (condominium_id IS NOT NULL);


--
-- Name: email_log_2026_condominium_id_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX email_log_2026_condominium_id_created_at_idx ON audit.email_log_2026 USING btree (condominium_id, created_at DESC) WHERE (condominium_id IS NOT NULL);


--
-- Name: idx_email_log_recipient; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX idx_email_log_recipient ON ONLY audit.email_log USING btree (recipient, created_at DESC);


--
-- Name: email_log_2026_recipient_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX email_log_2026_recipient_created_at_idx ON audit.email_log_2026 USING btree (recipient, created_at DESC);


--
-- Name: idx_email_log_unit; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX idx_email_log_unit ON ONLY audit.email_log USING btree (unit_id, created_at DESC) WHERE (unit_id IS NOT NULL);


--
-- Name: email_log_2026_unit_id_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX email_log_2026_unit_id_created_at_idx ON audit.email_log_2026 USING btree (unit_id, created_at DESC) WHERE (unit_id IS NOT NULL);


--
-- Name: email_log_2027_condominium_id_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX email_log_2027_condominium_id_created_at_idx ON audit.email_log_2027 USING btree (condominium_id, created_at DESC) WHERE (condominium_id IS NOT NULL);


--
-- Name: email_log_2027_recipient_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX email_log_2027_recipient_created_at_idx ON audit.email_log_2027 USING btree (recipient, created_at DESC);


--
-- Name: email_log_2027_unit_id_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX email_log_2027_unit_id_created_at_idx ON audit.email_log_2027 USING btree (unit_id, created_at DESC) WHERE (unit_id IS NOT NULL);


--
-- Name: email_log_2028_condominium_id_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX email_log_2028_condominium_id_created_at_idx ON audit.email_log_2028 USING btree (condominium_id, created_at DESC) WHERE (condominium_id IS NOT NULL);


--
-- Name: email_log_2028_recipient_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX email_log_2028_recipient_created_at_idx ON audit.email_log_2028 USING btree (recipient, created_at DESC);


--
-- Name: email_log_2028_unit_id_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX email_log_2028_unit_id_created_at_idx ON audit.email_log_2028 USING btree (unit_id, created_at DESC) WHERE (unit_id IS NOT NULL);


--
-- Name: email_log_default_condominium_id_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX email_log_default_condominium_id_created_at_idx ON audit.email_log_default USING btree (condominium_id, created_at DESC) WHERE (condominium_id IS NOT NULL);


--
-- Name: email_log_default_recipient_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX email_log_default_recipient_created_at_idx ON audit.email_log_default USING btree (recipient, created_at DESC);


--
-- Name: email_log_default_unit_id_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX email_log_default_unit_id_created_at_idx ON audit.email_log_default USING btree (unit_id, created_at DESC) WHERE (unit_id IS NOT NULL);


--
-- Name: idx_audit_cdc_log_actor; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX idx_audit_cdc_log_actor ON ONLY audit.cdc_log USING btree (((actor ->> 'id'::text)), created_at DESC) WHERE (actor IS NOT NULL);


--
-- Name: idx_audit_cdc_log_condo; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX idx_audit_cdc_log_condo ON ONLY audit.cdc_log USING btree (condominium_id, created_at DESC) WHERE (condominium_id IS NOT NULL);


--
-- Name: idx_audit_cdc_log_table_row; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX idx_audit_cdc_log_table_row ON ONLY audit.cdc_log USING btree (table_schema, table_name, row_id, created_at DESC);


--
-- Name: log_2026_condominium_id_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX log_2026_condominium_id_created_at_idx ON audit.cdc_log_2026 USING btree (condominium_id, created_at DESC) WHERE (condominium_id IS NOT NULL);


--
-- Name: log_2026_expr_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX log_2026_expr_created_at_idx ON audit.cdc_log_2026 USING btree (((actor ->> 'id'::text)), created_at DESC) WHERE (actor IS NOT NULL);


--
-- Name: log_2026_table_schema_table_name_row_id_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX log_2026_table_schema_table_name_row_id_created_at_idx ON audit.cdc_log_2026 USING btree (table_schema, table_name, row_id, created_at DESC);


--
-- Name: log_2027_condominium_id_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX log_2027_condominium_id_created_at_idx ON audit.cdc_log_2027 USING btree (condominium_id, created_at DESC) WHERE (condominium_id IS NOT NULL);


--
-- Name: log_2027_expr_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX log_2027_expr_created_at_idx ON audit.cdc_log_2027 USING btree (((actor ->> 'id'::text)), created_at DESC) WHERE (actor IS NOT NULL);


--
-- Name: log_2027_table_schema_table_name_row_id_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX log_2027_table_schema_table_name_row_id_created_at_idx ON audit.cdc_log_2027 USING btree (table_schema, table_name, row_id, created_at DESC);


--
-- Name: log_2028_condominium_id_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX log_2028_condominium_id_created_at_idx ON audit.cdc_log_2028 USING btree (condominium_id, created_at DESC) WHERE (condominium_id IS NOT NULL);


--
-- Name: log_2028_expr_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX log_2028_expr_created_at_idx ON audit.cdc_log_2028 USING btree (((actor ->> 'id'::text)), created_at DESC) WHERE (actor IS NOT NULL);


--
-- Name: log_2028_table_schema_table_name_row_id_created_at_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX log_2028_table_schema_table_name_row_id_created_at_idx ON audit.cdc_log_2028 USING btree (table_schema, table_name, row_id, created_at DESC);


--
-- Name: assembly_attendee_assembly_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX assembly_attendee_assembly_idx ON core.assembly_attendee USING btree (assembly_id) WHERE (deleted_at IS NULL);


--
-- Name: assembly_attendee_occupant_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX assembly_attendee_occupant_idx ON core.assembly_attendee USING btree (occupant_id) WHERE (deleted_at IS NULL);


--
-- Name: assembly_attendee_unique_unit; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX assembly_attendee_unique_unit ON core.assembly_attendee USING btree (assembly_id, unit_id, convocation_round) WHERE (deleted_at IS NULL);


--
-- Name: assembly_convocation_assembly_sent_at_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX assembly_convocation_assembly_sent_at_idx ON core.assembly_convocation USING btree (condominium_id, assembly_id, sent_at DESC);


--
-- Name: assembly_vote_agenda_item_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX assembly_vote_agenda_item_idx ON core.assembly_vote USING btree (assembly_agenda_item_id) WHERE (deleted_at IS NULL);


--
-- Name: assembly_vote_unique_unit; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX assembly_vote_unique_unit ON core.assembly_vote USING btree (assembly_agenda_item_id, unit_id) WHERE (deleted_at IS NULL);


--
-- Name: billing_reminder_unit_sent_at_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX billing_reminder_unit_sent_at_idx ON core.billing_reminder USING btree (condominium_id, unit_id, sent_at DESC);


--
-- Name: idx_assembly_agenda_item_assembly; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_assembly_agenda_item_assembly ON core.assembly_agenda_item USING btree (assembly_id);


--
-- Name: idx_assembly_agenda_item_ref; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_assembly_agenda_item_ref ON core.assembly_agenda_item USING btree (ref_type, ref_id) WHERE (ref_type IS NOT NULL);


--
-- Name: idx_assembly_condo; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_assembly_condo ON core.assembly USING btree (condominium_id);


--
-- Name: idx_assembly_scheduled; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_assembly_scheduled ON core.assembly USING btree (condominium_id, scheduled_at);


--
-- Name: idx_attachment_condo_recent; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_attachment_condo_recent ON core.attachment USING btree (condominium_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_attachment_entity; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_attachment_entity ON core.attachment USING btree (condominium_id, entity_type, entity_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_budget_lines_budget; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_budget_lines_budget ON core.budget_line USING btree (budget_id);


--
-- Name: idx_budgets_condo; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_budgets_condo ON core.budget USING btree (condominium_id);


--
-- Name: idx_document_condo_public; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_document_condo_public ON core.document USING btree (condominium_id, is_public, published_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_document_condo_recent; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_document_condo_recent ON core.document USING btree (condominium_id, published_at DESC, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_inspection_condo_valid_until; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_inspection_condo_valid_until ON core.inspection USING btree (condominium_id, valid_until) WHERE (deleted_at IS NULL);


--
-- Name: idx_inspection_supplier; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_inspection_supplier ON core.inspection USING btree (supplier_id) WHERE (supplier_id IS NOT NULL);


--
-- Name: idx_insurance_policy_condo_status; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_insurance_policy_condo_status ON core.insurance_policy USING btree (condominium_id, status);


--
-- Name: idx_insurance_policy_renewed_from; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_insurance_policy_renewed_from ON core.insurance_policy USING btree (renewed_from_id);


--
-- Name: idx_insurance_policy_unit_valid; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_insurance_policy_unit_valid ON core.insurance_policy USING btree (unit_id, valid_to DESC);


--
-- Name: idx_insurance_reminder_condo; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_insurance_reminder_condo ON core.insurance_reminder USING btree (condominium_id, sent_at DESC);


--
-- Name: idx_insurance_reminder_unit; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_insurance_reminder_unit ON core.insurance_reminder USING btree (unit_id, sent_at DESC);


--
-- Name: idx_invite_token_user_active; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_invite_token_user_active ON core.invite_token USING btree (user_id) WHERE (used_at IS NULL);


--
-- Name: idx_occupants_condo; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_occupants_condo ON core.occupant USING btree (condominium_id);


--
-- Name: idx_occupants_user; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_occupants_user ON core.occupant USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_occupants_user_condo_unique; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX idx_occupants_user_condo_unique ON core.occupant USING btree (condominium_id, user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_quota_generation_run_budget; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_quota_generation_run_budget ON core.quota_generation_run USING btree (budget_id);


--
-- Name: idx_recurring_template_condo; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_recurring_template_condo ON core.recurring_template USING btree (condominium_id);


--
-- Name: idx_recurring_template_next_run; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_recurring_template_next_run ON core.recurring_template USING btree (next_run_date) WHERE ((is_active = true) AND (deleted_at IS NULL));


--
-- Name: idx_recurring_template_supplier; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_recurring_template_supplier ON core.recurring_template USING btree (supplier_id) WHERE (supplier_id IS NOT NULL);


--
-- Name: idx_suppliers_condominium; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_suppliers_condominium ON core.supplier USING btree (condominium_id);


--
-- Name: idx_ticket_condo_status; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_ticket_condo_status ON core.ticket USING btree (condominium_id, status, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_ticket_reported_by_occupant; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_ticket_reported_by_occupant ON core.ticket USING btree (reported_by_occupant_id) WHERE (reported_by_occupant_id IS NOT NULL);


--
-- Name: idx_unit_occupants_dates; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_unit_occupants_dates ON core.unit_occupant USING btree (unit_id, relationship_type) WHERE (end_date IS NULL);


--
-- Name: idx_unit_occupants_occupant; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_unit_occupants_occupant ON core.unit_occupant USING btree (occupant_id);


--
-- Name: idx_unit_occupants_unit; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_unit_occupants_unit ON core.unit_occupant USING btree (unit_id);


--
-- Name: idx_units_condo; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_units_condo ON core.unit USING btree (condominium_id);


--
-- Name: inspection_code_unique; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX inspection_code_unique ON core.inspection USING btree (condominium_id, code) WHERE (code IS NOT NULL);


--
-- Name: pathology_code_unique; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX pathology_code_unique ON core.pathology USING btree (condominium_id, code) WHERE (code IS NOT NULL);


--
-- Name: pathology_condominium_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX pathology_condominium_idx ON core.pathology USING btree (condominium_id) WHERE (deleted_at IS NULL);


--
-- Name: pathology_status_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX pathology_status_idx ON core.pathology USING btree (condominium_id, status) WHERE (deleted_at IS NULL);


--
-- Name: pathology_unit_by_unit_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX pathology_unit_by_unit_idx ON core.pathology_unit USING btree (unit_id);


--
-- Name: payment_plan_condominium_active_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX payment_plan_condominium_active_idx ON core.payment_plan USING btree (condominium_id, status) WHERE (deleted_at IS NULL);


--
-- Name: payment_plan_one_active_per_unit; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX payment_plan_one_active_per_unit ON core.payment_plan USING btree (unit_id) WHERE (((status)::text = 'active'::text) AND (deleted_at IS NULL));


--
-- Name: payment_plan_unit_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX payment_plan_unit_idx ON core.payment_plan USING btree (unit_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: ticket_code_unique; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX ticket_code_unique ON core.ticket USING btree (condominium_id, code) WHERE (code IS NOT NULL);


--
-- Name: ticket_pathology_id_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX ticket_pathology_id_idx ON core.ticket USING btree (pathology_id) WHERE ((pathology_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: users_email_active_uq; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX users_email_active_uq ON core."user" USING btree (email) WHERE (deleted_at IS NULL);


--
-- Name: chart_of_account_custom_unique; Type: INDEX; Schema: finance; Owner: -
--

CREATE UNIQUE INDEX chart_of_account_custom_unique ON finance.chart_of_account USING btree (code, condominium_id) WHERE ((condominium_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: chart_of_account_global_unique; Type: INDEX; Schema: finance; Owner: -
--

CREATE UNIQUE INDEX chart_of_account_global_unique ON finance.chart_of_account USING btree (code) WHERE ((condominium_id IS NULL) AND (deleted_at IS NULL));


--
-- Name: finance_charge_code_unique; Type: INDEX; Schema: finance; Owner: -
--

CREATE UNIQUE INDEX finance_charge_code_unique ON finance.charge USING btree (condominium_id, code) WHERE (code IS NOT NULL);


--
-- Name: idx_bank_account_quota_payment; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_bank_account_quota_payment ON finance.bank_account USING btree (condominium_id) WHERE ((is_quota_payment = true) AND (deleted_at IS NULL));


--
-- Name: idx_bank_accounts_condo; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_bank_accounts_condo ON finance.bank_account USING btree (condominium_id);


--
-- Name: idx_bank_batches_account; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_bank_batches_account ON finance.bank_import_batch USING btree (bank_account_id);


--
-- Name: idx_bank_batches_condo; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_bank_batches_condo ON finance.bank_import_batch USING btree (condominium_id);


--
-- Name: idx_bank_tx_account; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_bank_tx_account ON finance.bank_transaction USING btree (bank_account_id);


--
-- Name: idx_bank_tx_condo; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_bank_tx_condo ON finance.bank_transaction USING btree (condominium_id);


--
-- Name: idx_bank_tx_date; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_bank_tx_date ON finance.bank_transaction USING btree (transaction_date);


--
-- Name: idx_bank_tx_hash; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_bank_tx_hash ON finance.bank_transaction USING btree (import_hash);


--
-- Name: idx_bank_tx_reconciled; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_bank_tx_reconciled ON finance.bank_transaction USING btree (is_reconciled);


--
-- Name: idx_charge_account_id; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_charge_account_id ON finance.charge USING btree (account_id) WHERE (account_id IS NOT NULL);


--
-- Name: idx_charge_budget; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_charge_budget ON finance.charge USING btree (budget_id) WHERE (budget_id IS NOT NULL);


--
-- Name: idx_charge_competence; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_charge_competence ON finance.charge USING btree (condominium_id, competence_period);


--
-- Name: idx_charge_condo; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_charge_condo ON finance.charge USING btree (condominium_id);


--
-- Name: idx_charge_contract; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_charge_contract ON finance.charge USING btree (contract_id) WHERE (contract_id IS NOT NULL);


--
-- Name: idx_charge_kind_status; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_charge_kind_status ON finance.charge USING btree (kind, status);


--
-- Name: idx_charge_open_credits; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_charge_open_credits ON finance.charge USING btree (condominium_id, unit_id) WHERE (((status)::text = ANY (ARRAY[('open'::character varying)::text, ('partial'::character varying)::text])) AND ((nature)::text = 'credit'::text));


--
-- Name: idx_charge_open_debits; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_charge_open_debits ON finance.charge USING btree (condominium_id, unit_id) WHERE (((status)::text = ANY (ARRAY[('open'::character varying)::text, ('partial'::character varying)::text, ('overdue'::character varying)::text])) AND ((nature)::text = 'debit'::text));


--
-- Name: idx_charge_recurring_template; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_charge_recurring_template ON finance.charge USING btree (recurring_template_id) WHERE (recurring_template_id IS NOT NULL);


--
-- Name: idx_charge_supplier; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_charge_supplier ON finance.charge USING btree (supplier_id) WHERE (supplier_id IS NOT NULL);


--
-- Name: idx_charge_unit; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_charge_unit ON finance.charge USING btree (unit_id) WHERE (unit_id IS NOT NULL);


--
-- Name: idx_chart_of_account_condo; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_chart_of_account_condo ON finance.chart_of_account USING btree (condominium_id) WHERE (condominium_id IS NOT NULL);


--
-- Name: idx_fcr_transfer_condo_date; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_fcr_transfer_condo_date ON finance.fcr_transfer USING btree (condominium_id, transfer_date DESC);


--
-- Name: idx_fiscal_year_condo; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_fiscal_year_condo ON finance.fiscal_year USING btree (condominium_id);


--
-- Name: idx_ledger2_account; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_ledger2_account ON finance.ledger USING btree (condominium_id, account_code);


--
-- Name: idx_ledger2_condo; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_ledger2_condo ON finance.ledger USING btree (condominium_id);


--
-- Name: idx_ledger2_date; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_ledger2_date ON finance.ledger USING btree (condominium_id, entry_date);


--
-- Name: idx_ledger2_ref; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_ledger2_ref ON finance.ledger USING btree (ref_type, ref_id);


--
-- Name: idx_ledger2_unit; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_ledger2_unit ON finance.ledger USING btree (unit_id) WHERE (unit_id IS NOT NULL);


--
-- Name: idx_receipt_skip_active_uniq; Type: INDEX; Schema: finance; Owner: -
--

CREATE UNIQUE INDEX idx_receipt_skip_active_uniq ON finance.receipt_skip USING btree (bank_transaction_id, unit_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_receipt_skip_condo; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_receipt_skip_condo ON finance.receipt_skip USING btree (condominium_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_settlement_bank_tx; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_settlement_bank_tx ON finance.settlement USING btree (bank_transaction_id) WHERE (bank_transaction_id IS NOT NULL);


--
-- Name: idx_settlement_condo; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_settlement_condo ON finance.settlement USING btree (condominium_id);


--
-- Name: idx_settlement_credit; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_settlement_credit ON finance.settlement USING btree (credit_charge_id);


--
-- Name: idx_settlement_debit; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_settlement_debit ON finance.settlement USING btree (debit_charge_id);


--
-- Name: idx_settlement_unit; Type: INDEX; Schema: finance; Owner: -
--

CREATE INDEX idx_settlement_unit ON finance.settlement USING btree (unit_id) WHERE (unit_id IS NOT NULL);


--
-- Name: uq_charge_quota_unit_period_source; Type: INDEX; Schema: finance; Owner: -
--

CREATE UNIQUE INDEX uq_charge_quota_unit_period_source ON finance.charge USING btree (unit_id, competence_period, source_id) WHERE (((charge_type)::text = 'quota'::text) AND ((status)::text <> 'cancelled'::text));


--
-- Name: email_log_2026_condominium_id_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_email_log_condo ATTACH PARTITION audit.email_log_2026_condominium_id_created_at_idx;


--
-- Name: email_log_2026_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.email_log_pkey ATTACH PARTITION audit.email_log_2026_pkey;


--
-- Name: email_log_2026_recipient_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_email_log_recipient ATTACH PARTITION audit.email_log_2026_recipient_created_at_idx;


--
-- Name: email_log_2026_unit_id_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_email_log_unit ATTACH PARTITION audit.email_log_2026_unit_id_created_at_idx;


--
-- Name: email_log_2027_condominium_id_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_email_log_condo ATTACH PARTITION audit.email_log_2027_condominium_id_created_at_idx;


--
-- Name: email_log_2027_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.email_log_pkey ATTACH PARTITION audit.email_log_2027_pkey;


--
-- Name: email_log_2027_recipient_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_email_log_recipient ATTACH PARTITION audit.email_log_2027_recipient_created_at_idx;


--
-- Name: email_log_2027_unit_id_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_email_log_unit ATTACH PARTITION audit.email_log_2027_unit_id_created_at_idx;


--
-- Name: email_log_2028_condominium_id_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_email_log_condo ATTACH PARTITION audit.email_log_2028_condominium_id_created_at_idx;


--
-- Name: email_log_2028_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.email_log_pkey ATTACH PARTITION audit.email_log_2028_pkey;


--
-- Name: email_log_2028_recipient_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_email_log_recipient ATTACH PARTITION audit.email_log_2028_recipient_created_at_idx;


--
-- Name: email_log_2028_unit_id_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_email_log_unit ATTACH PARTITION audit.email_log_2028_unit_id_created_at_idx;


--
-- Name: email_log_default_condominium_id_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_email_log_condo ATTACH PARTITION audit.email_log_default_condominium_id_created_at_idx;


--
-- Name: email_log_default_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.email_log_pkey ATTACH PARTITION audit.email_log_default_pkey;


--
-- Name: email_log_default_recipient_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_email_log_recipient ATTACH PARTITION audit.email_log_default_recipient_created_at_idx;


--
-- Name: email_log_default_unit_id_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_email_log_unit ATTACH PARTITION audit.email_log_default_unit_id_created_at_idx;


--
-- Name: log_2026_condominium_id_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_audit_cdc_log_condo ATTACH PARTITION audit.log_2026_condominium_id_created_at_idx;


--
-- Name: log_2026_expr_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_audit_cdc_log_actor ATTACH PARTITION audit.log_2026_expr_created_at_idx;


--
-- Name: log_2026_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.log_pkey ATTACH PARTITION audit.log_2026_pkey;


--
-- Name: log_2026_table_schema_table_name_row_id_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_audit_cdc_log_table_row ATTACH PARTITION audit.log_2026_table_schema_table_name_row_id_created_at_idx;


--
-- Name: log_2027_condominium_id_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_audit_cdc_log_condo ATTACH PARTITION audit.log_2027_condominium_id_created_at_idx;


--
-- Name: log_2027_expr_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_audit_cdc_log_actor ATTACH PARTITION audit.log_2027_expr_created_at_idx;


--
-- Name: log_2027_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.log_pkey ATTACH PARTITION audit.log_2027_pkey;


--
-- Name: log_2027_table_schema_table_name_row_id_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_audit_cdc_log_table_row ATTACH PARTITION audit.log_2027_table_schema_table_name_row_id_created_at_idx;


--
-- Name: log_2028_condominium_id_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_audit_cdc_log_condo ATTACH PARTITION audit.log_2028_condominium_id_created_at_idx;


--
-- Name: log_2028_expr_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_audit_cdc_log_actor ATTACH PARTITION audit.log_2028_expr_created_at_idx;


--
-- Name: log_2028_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.log_pkey ATTACH PARTITION audit.log_2028_pkey;


--
-- Name: log_2028_table_schema_table_name_row_id_created_at_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.idx_audit_cdc_log_table_row ATTACH PARTITION audit.log_2028_table_schema_table_name_row_id_created_at_idx;


--
-- Name: cdc_log trg_audit_cdc_log_no_direct_insert; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER trg_audit_cdc_log_no_direct_insert BEFORE INSERT ON audit.cdc_log FOR EACH ROW WHEN ((pg_trigger_depth() < 2)) EXECUTE FUNCTION audit.fn_reject_direct_insert();


--
-- Name: email_log trg_audit_email_log_no_delete; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER trg_audit_email_log_no_delete BEFORE DELETE ON audit.email_log FOR EACH ROW EXECUTE FUNCTION audit.fn_reject_modification();


--
-- Name: email_log trg_audit_email_log_no_truncate; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER trg_audit_email_log_no_truncate BEFORE TRUNCATE ON audit.email_log FOR EACH STATEMENT EXECUTE FUNCTION audit.fn_reject_modification();


--
-- Name: email_log trg_audit_email_log_no_update; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER trg_audit_email_log_no_update BEFORE UPDATE ON audit.email_log FOR EACH ROW EXECUTE FUNCTION audit.fn_reject_modification();


--
-- Name: cdc_log trg_audit_log_no_delete; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER trg_audit_log_no_delete BEFORE DELETE ON audit.cdc_log FOR EACH ROW EXECUTE FUNCTION audit.fn_reject_modification();


--
-- Name: cdc_log trg_audit_log_no_truncate; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER trg_audit_log_no_truncate BEFORE TRUNCATE ON audit.cdc_log FOR EACH STATEMENT EXECUTE FUNCTION audit.fn_reject_modification();


--
-- Name: cdc_log trg_audit_log_no_update; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER trg_audit_log_no_update BEFORE UPDATE ON audit.cdc_log FOR EACH ROW EXECUTE FUNCTION audit.fn_reject_modification();


--
-- Name: assembly trg_assembly_held_approve_budgets; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_assembly_held_approve_budgets AFTER UPDATE OF status ON core.assembly FOR EACH ROW EXECUTE FUNCTION core.fn_assembly_held_approve_budgets();


--
-- Name: assembly_vote trg_assembly_vote_aggregate_aiud; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_assembly_vote_aggregate_aiud AFTER INSERT OR DELETE OR UPDATE ON core.assembly_vote FOR EACH ROW EXECUTE FUNCTION core.fn_assembly_vote_aggregate();


--
-- Name: assembly trg_audit_core_assembly; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_assembly AFTER INSERT OR DELETE OR UPDATE ON core.assembly FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: assembly_agenda_item trg_audit_core_assembly_agenda_item; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_assembly_agenda_item AFTER INSERT OR DELETE OR UPDATE ON core.assembly_agenda_item FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: assembly_attendee trg_audit_core_assembly_attendee; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_assembly_attendee AFTER INSERT OR DELETE OR UPDATE ON core.assembly_attendee FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: assembly_convocation trg_audit_core_assembly_convocation; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_assembly_convocation AFTER INSERT OR DELETE OR UPDATE ON core.assembly_convocation FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: assembly_vote trg_audit_core_assembly_vote; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_assembly_vote AFTER INSERT OR DELETE OR UPDATE ON core.assembly_vote FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: attachment trg_audit_core_attachment; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_attachment AFTER INSERT OR DELETE OR UPDATE ON core.attachment FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: billing_reminder trg_audit_core_billing_reminder; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_billing_reminder AFTER INSERT OR DELETE OR UPDATE ON core.billing_reminder FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: budget trg_audit_core_budget; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_budget AFTER INSERT OR DELETE OR UPDATE ON core.budget FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: budget_line trg_audit_core_budget_line; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_budget_line AFTER INSERT OR DELETE OR UPDATE ON core.budget_line FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: condominium trg_audit_core_condominium; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_condominium AFTER INSERT OR DELETE OR UPDATE ON core.condominium FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: document trg_audit_core_document; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_document AFTER INSERT OR DELETE OR UPDATE ON core.document FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: inspection trg_audit_core_inspection; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_inspection AFTER INSERT OR DELETE OR UPDATE ON core.inspection FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: inspection_code_counter trg_audit_core_inspection_code_counter; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_inspection_code_counter AFTER INSERT OR DELETE OR UPDATE ON core.inspection_code_counter FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: insurance_policy trg_audit_core_insurance_policy; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_insurance_policy AFTER INSERT OR DELETE OR UPDATE ON core.insurance_policy FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: insurance_reminder trg_audit_core_insurance_reminder; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_insurance_reminder AFTER INSERT OR DELETE OR UPDATE ON core.insurance_reminder FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: invite_token trg_audit_core_invite_token; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_invite_token AFTER INSERT OR DELETE OR UPDATE ON core.invite_token FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: manager trg_audit_core_manager; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_manager AFTER INSERT OR DELETE OR UPDATE ON core.manager FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: occupant trg_audit_core_occupant; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_occupant AFTER INSERT OR DELETE OR UPDATE ON core.occupant FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: pathology trg_audit_core_pathology; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_pathology AFTER INSERT OR DELETE OR UPDATE ON core.pathology FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: pathology_code_counter trg_audit_core_pathology_code_counter; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_pathology_code_counter AFTER INSERT OR DELETE OR UPDATE ON core.pathology_code_counter FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: pathology_unit trg_audit_core_pathology_unit; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_pathology_unit AFTER INSERT OR DELETE OR UPDATE ON core.pathology_unit FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: payment_plan trg_audit_core_payment_plan; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_payment_plan AFTER INSERT OR DELETE OR UPDATE ON core.payment_plan FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: quota_generation_run trg_audit_core_quota_generation_run; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_quota_generation_run AFTER INSERT OR DELETE OR UPDATE ON core.quota_generation_run FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: recurring_generation_run trg_audit_core_recurring_generation_run; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_recurring_generation_run AFTER INSERT OR DELETE OR UPDATE ON core.recurring_generation_run FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: recurring_template trg_audit_core_recurring_template; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_recurring_template AFTER INSERT OR DELETE OR UPDATE ON core.recurring_template FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: supplier trg_audit_core_supplier; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_supplier AFTER INSERT OR DELETE OR UPDATE ON core.supplier FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: ticket trg_audit_core_ticket; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_ticket AFTER INSERT OR DELETE OR UPDATE ON core.ticket FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: ticket_code_counter trg_audit_core_ticket_code_counter; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_ticket_code_counter AFTER INSERT OR DELETE OR UPDATE ON core.ticket_code_counter FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: ticket_comment trg_audit_core_ticket_comment; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_ticket_comment AFTER INSERT OR DELETE OR UPDATE ON core.ticket_comment FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: unit trg_audit_core_unit; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_unit AFTER INSERT OR DELETE OR UPDATE ON core.unit FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: unit_occupant trg_audit_core_unit_occupant; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_unit_occupant AFTER INSERT OR DELETE OR UPDATE ON core.unit_occupant FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: user trg_audit_core_user; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_audit_core_user AFTER INSERT OR DELETE OR UPDATE ON core."user" FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: inspection trg_inspection_code_assign; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_inspection_code_assign BEFORE INSERT ON core.inspection FOR EACH ROW EXECUTE FUNCTION core.fn_inspection_assign_code();


--
-- Name: pathology trg_pathology_code_assign; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_pathology_code_assign BEFORE INSERT ON core.pathology FOR EACH ROW EXECUTE FUNCTION core.fn_pathology_assign_code();


--
-- Name: assembly trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.assembly FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('minutes_document_id=core.document', 'president_occupant_id=core.occupant', 'secretary_occupant_id=core.occupant');


--
-- Name: assembly_agenda_item trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.assembly_agenda_item FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('assembly_id=core.assembly', 'ref_id@ref_type=budget:core.budget');


--
-- Name: assembly_attendee trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.assembly_attendee FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('assembly_id=core.assembly', 'unit_id=core.unit', 'occupant_id=core.occupant', 'proxy_holder_occupant_id=core.occupant');


--
-- Name: assembly_convocation trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.assembly_convocation FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('assembly_id=core.assembly');


--
-- Name: assembly_vote trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.assembly_vote FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('assembly_agenda_item_id=core.assembly_agenda_item', 'unit_id=core.unit', 'occupant_id=core.occupant');


--
-- Name: attachment trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.attachment FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('entity_id@entity_type=charge:finance.charge,ticket:core.ticket,inspection:core.inspection,assembly:core.assembly,insurance:core.insurance_policy,document:core.document,pathology:core.pathology');


--
-- Name: billing_reminder trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.billing_reminder FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('unit_id=core.unit');


--
-- Name: budget trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.budget FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('parent_budget_id=core.budget');


--
-- Name: budget_line trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.budget_line FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('budget_id=core.budget', 'account_id=finance.chart_of_account');


--
-- Name: inspection trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.inspection FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('supplier_id=core.supplier');


--
-- Name: insurance_policy trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.insurance_policy FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('unit_id=core.unit', 'renewed_from_id=core.insurance_policy');


--
-- Name: insurance_reminder trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.insurance_reminder FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('unit_id=core.unit');


--
-- Name: pathology_unit trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.pathology_unit FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('pathology_id=core.pathology', 'unit_id=core.unit');


--
-- Name: payment_plan trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.payment_plan FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('unit_id=core.unit');


--
-- Name: quota_generation_run trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.quota_generation_run FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('budget_id=core.budget');


--
-- Name: recurring_template trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.recurring_template FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('account_id=finance.chart_of_account', 'supplier_id=core.supplier', 'unit_id=core.unit');


--
-- Name: supplier trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.supplier FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('account_id=finance.chart_of_account');


--
-- Name: ticket trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.ticket FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('unit_id=core.unit', 'pathology_id=core.pathology', 'reported_by_occupant_id=core.occupant');


--
-- Name: ticket_comment trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.ticket_comment FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('ticket_id=core.ticket');


--
-- Name: unit_occupant trg_tenant_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON core.unit_occupant FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('unit_id=core.unit', 'occupant_id=core.occupant');


--
-- Name: ticket trg_ticket_code_assign; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_ticket_code_assign BEFORE INSERT ON core.ticket FOR EACH ROW EXECUTE FUNCTION core.fn_ticket_assign_code();


--
-- Name: bank_account trg_audit_finance_bank_account; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_audit_finance_bank_account AFTER INSERT OR DELETE OR UPDATE ON finance.bank_account FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: bank_import_batch trg_audit_finance_bank_import_batch; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_audit_finance_bank_import_batch AFTER INSERT OR DELETE OR UPDATE ON finance.bank_import_batch FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: bank_transaction trg_audit_finance_bank_transaction; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_audit_finance_bank_transaction AFTER INSERT OR DELETE OR UPDATE ON finance.bank_transaction FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: charge trg_audit_finance_charge; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_audit_finance_charge AFTER INSERT OR DELETE OR UPDATE ON finance.charge FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: charge_code_counter trg_audit_finance_charge_code_counter; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_audit_finance_charge_code_counter AFTER INSERT OR DELETE OR UPDATE ON finance.charge_code_counter FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: chart_of_account trg_audit_finance_chart_of_account; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_audit_finance_chart_of_account AFTER INSERT OR DELETE OR UPDATE ON finance.chart_of_account FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: fcr_transfer trg_audit_finance_fcr_transfer; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_audit_finance_fcr_transfer AFTER INSERT OR DELETE OR UPDATE ON finance.fcr_transfer FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: fiscal_year trg_audit_finance_fiscal_year; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_audit_finance_fiscal_year AFTER INSERT OR DELETE OR UPDATE ON finance.fiscal_year FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: ledger trg_audit_finance_ledger; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_audit_finance_ledger AFTER INSERT OR DELETE OR UPDATE ON finance.ledger FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: receipt trg_audit_finance_receipt; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_audit_finance_receipt AFTER INSERT OR DELETE OR UPDATE ON finance.receipt FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: receipt_skip trg_audit_finance_receipt_skip; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_audit_finance_receipt_skip AFTER INSERT OR DELETE OR UPDATE ON finance.receipt_skip FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: settlement trg_audit_finance_settlement; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_audit_finance_settlement AFTER INSERT OR DELETE OR UPDATE ON finance.settlement FOR EACH ROW EXECUTE FUNCTION audit.fn_log_change();


--
-- Name: charge trg_block_charge_closed; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_block_charge_closed BEFORE INSERT OR UPDATE ON finance.charge FOR EACH ROW EXECUTE FUNCTION core.fn_block_closed_fiscal_year();


--
-- Name: ledger trg_block_ledger_closed; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_block_ledger_closed BEFORE INSERT OR UPDATE ON finance.ledger FOR EACH ROW EXECUTE FUNCTION core.fn_block_closed_fiscal_year();


--
-- Name: charge trg_charge_ai; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_charge_ai AFTER INSERT ON finance.charge FOR EACH ROW EXECUTE FUNCTION finance.fn_charge_ai();


--
-- Name: charge trg_charge_amount_adjust_ledger; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_charge_amount_adjust_ledger AFTER UPDATE OF original_amount ON finance.charge FOR EACH ROW EXECUTE FUNCTION finance.fn_charge_amount_adjust_ledger();


--
-- Name: charge trg_charge_au; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_charge_au AFTER UPDATE ON finance.charge FOR EACH ROW EXECUTE FUNCTION finance.fn_charge_au();


--
-- Name: charge trg_charge_bu; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_charge_bu BEFORE UPDATE ON finance.charge FOR EACH ROW EXECUTE FUNCTION finance.fn_charge_bu();


--
-- Name: charge trg_charge_code_assign; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_charge_code_assign BEFORE INSERT ON finance.charge FOR EACH ROW EXECUTE FUNCTION finance.fn_charge_assign_code();


--
-- Name: ledger trg_ledger_no_delete; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_ledger_no_delete BEFORE DELETE ON finance.ledger FOR EACH ROW EXECUTE FUNCTION finance.fn_reject_ledger_modification();


--
-- Name: ledger trg_ledger_no_truncate; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_ledger_no_truncate BEFORE TRUNCATE ON finance.ledger FOR EACH STATEMENT EXECUTE FUNCTION finance.fn_reject_ledger_modification();


--
-- Name: ledger trg_ledger_no_update; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_ledger_no_update BEFORE UPDATE ON finance.ledger FOR EACH ROW EXECUTE FUNCTION finance.fn_reject_ledger_modification();


--
-- Name: charge trg_refacturation_validate; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_refacturation_validate BEFORE INSERT ON finance.charge FOR EACH ROW EXECUTE FUNCTION core.fn_refacturation_validate();


--
-- Name: settlement trg_settlement_ai; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_settlement_ai AFTER INSERT ON finance.settlement FOR EACH ROW EXECUTE FUNCTION finance.fn_settlement_ai();


--
-- Name: settlement trg_settlement_au; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_settlement_au AFTER UPDATE ON finance.settlement FOR EACH ROW EXECUTE FUNCTION finance.fn_settlement_au();


--
-- Name: settlement trg_settlement_bi; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_settlement_bi BEFORE INSERT ON finance.settlement FOR EACH ROW EXECUTE FUNCTION finance.fn_settlement_bi();


--
-- Name: bank_import_batch trg_tenant_guard; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON finance.bank_import_batch FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('bank_account_id=finance.bank_account');


--
-- Name: bank_transaction trg_tenant_guard; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON finance.bank_transaction FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('bank_account_id=finance.bank_account', 'import_batch_id=finance.bank_import_batch', 'reversed_by_transaction_id=finance.bank_transaction');


--
-- Name: charge trg_tenant_guard; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON finance.charge FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('unit_id=core.unit', 'account_id=finance.chart_of_account', 'supplier_id=core.supplier', 'recurring_template_id=core.recurring_template', 'budget_id=core.budget', 'source_id@source_type=budget:core.budget,recurring_template:core.recurring_template,refacturation:finance.charge,supplier_refund:finance.charge,bank_transaction:finance.bank_transaction,bank_account:finance.bank_account');


--
-- Name: fiscal_year trg_tenant_guard; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON finance.fiscal_year FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('closed_assembly_id=core.assembly');


--
-- Name: receipt trg_tenant_guard; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON finance.receipt FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('unit_id=core.unit', 'bank_transaction_id=finance.bank_transaction');


--
-- Name: receipt_skip trg_tenant_guard; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON finance.receipt_skip FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('unit_id=core.unit', 'bank_transaction_id=finance.bank_transaction');


--
-- Name: settlement trg_tenant_guard; Type: TRIGGER; Schema: finance; Owner: -
--

CREATE TRIGGER trg_tenant_guard BEFORE INSERT OR UPDATE ON finance.settlement FOR EACH ROW EXECUTE FUNCTION core.fn_tenant_guard('unit_id=core.unit', 'debit_charge_id=finance.charge', 'credit_charge_id=finance.charge', 'bank_transaction_id=finance.bank_transaction', 'debit_ref_id@debit_ref_type=charge:finance.charge,bank_transaction:finance.bank_transaction', 'credit_ref_id@credit_ref_type=charge:finance.charge,bank_transaction:finance.bank_transaction');


--
-- Name: assembly_agenda_item assembly_agenda_item_assembly_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.assembly_agenda_item
    ADD CONSTRAINT assembly_agenda_item_assembly_id_fkey FOREIGN KEY (assembly_id) REFERENCES core.assembly(id) ON DELETE CASCADE;


--
-- Name: assembly_attendee assembly_attendee_assembly_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.assembly_attendee
    ADD CONSTRAINT assembly_attendee_assembly_id_fkey FOREIGN KEY (assembly_id) REFERENCES core.assembly(id);


--
-- Name: assembly_attendee assembly_attendee_occupant_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.assembly_attendee
    ADD CONSTRAINT assembly_attendee_occupant_id_fkey FOREIGN KEY (occupant_id) REFERENCES core.occupant(id);


--
-- Name: assembly_attendee assembly_attendee_represented_occupant_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.assembly_attendee
    ADD CONSTRAINT assembly_attendee_represented_occupant_id_fkey FOREIGN KEY (proxy_holder_occupant_id) REFERENCES core.occupant(id);


--
-- Name: assembly_attendee assembly_attendee_unit_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.assembly_attendee
    ADD CONSTRAINT assembly_attendee_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit(id);


--
-- Name: assembly assembly_condominium_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.assembly
    ADD CONSTRAINT assembly_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: assembly assembly_president_fk; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.assembly
    ADD CONSTRAINT assembly_president_fk FOREIGN KEY (president_occupant_id) REFERENCES core.occupant(id);


--
-- Name: assembly assembly_secretary_fk; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.assembly
    ADD CONSTRAINT assembly_secretary_fk FOREIGN KEY (secretary_occupant_id) REFERENCES core.occupant(id);


--
-- Name: assembly_vote assembly_vote_assembly_agenda_item_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.assembly_vote
    ADD CONSTRAINT assembly_vote_assembly_agenda_item_id_fkey FOREIGN KEY (assembly_agenda_item_id) REFERENCES core.assembly_agenda_item(id);


--
-- Name: assembly_vote assembly_vote_occupant_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.assembly_vote
    ADD CONSTRAINT assembly_vote_occupant_id_fkey FOREIGN KEY (occupant_id) REFERENCES core.occupant(id);


--
-- Name: assembly_vote assembly_vote_unit_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.assembly_vote
    ADD CONSTRAINT assembly_vote_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit(id);


--
-- Name: attachment attachment_condominium_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.attachment
    ADD CONSTRAINT attachment_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: budget_line budget_lines_account_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.budget_line
    ADD CONSTRAINT budget_lines_account_id_fkey FOREIGN KEY (account_id) REFERENCES finance.chart_of_account(id);


--
-- Name: budget_line budget_lines_budget_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.budget_line
    ADD CONSTRAINT budget_lines_budget_id_fkey FOREIGN KEY (budget_id) REFERENCES core.budget(id) ON DELETE CASCADE;


--
-- Name: budget budget_parent_budget_fk; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.budget
    ADD CONSTRAINT budget_parent_budget_fk FOREIGN KEY (parent_budget_id) REFERENCES core.budget(id) ON DELETE RESTRICT;


--
-- Name: budget budgets_approved_by_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.budget
    ADD CONSTRAINT budgets_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES core."user"(id);


--
-- Name: budget budgets_condominium_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.budget
    ADD CONSTRAINT budgets_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: budget budgets_parent_budget_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.budget
    ADD CONSTRAINT budgets_parent_budget_id_fkey FOREIGN KEY (parent_budget_id) REFERENCES core.budget(id);


--
-- Name: document document_condominium_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.document
    ADD CONSTRAINT document_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: inspection inspection_condominium_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.inspection
    ADD CONSTRAINT inspection_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: inspection inspection_supplier_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.inspection
    ADD CONSTRAINT inspection_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES core.supplier(id) ON DELETE SET NULL;


--
-- Name: insurance_policy insurance_policy_condominium_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.insurance_policy
    ADD CONSTRAINT insurance_policy_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: insurance_policy insurance_policy_renewed_from_fk; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.insurance_policy
    ADD CONSTRAINT insurance_policy_renewed_from_fk FOREIGN KEY (renewed_from_id) REFERENCES core.insurance_policy(id) ON DELETE RESTRICT;


--
-- Name: insurance_policy insurance_policy_unit_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.insurance_policy
    ADD CONSTRAINT insurance_policy_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit(id);


--
-- Name: insurance_reminder insurance_reminder_condominium_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.insurance_reminder
    ADD CONSTRAINT insurance_reminder_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: insurance_reminder insurance_reminder_unit_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.insurance_reminder
    ADD CONSTRAINT insurance_reminder_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit(id);


--
-- Name: invite_token invite_token_user_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.invite_token
    ADD CONSTRAINT invite_token_user_id_fkey FOREIGN KEY (user_id) REFERENCES core."user"(id) ON DELETE CASCADE;


--
-- Name: occupant occupants_condominium_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.occupant
    ADD CONSTRAINT occupants_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: occupant occupants_user_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.occupant
    ADD CONSTRAINT occupants_user_id_fkey FOREIGN KEY (user_id) REFERENCES core."user"(id) ON DELETE SET NULL;


--
-- Name: pathology pathology_condominium_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.pathology
    ADD CONSTRAINT pathology_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: pathology_unit pathology_unit_pathology_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.pathology_unit
    ADD CONSTRAINT pathology_unit_pathology_id_fkey FOREIGN KEY (pathology_id) REFERENCES core.pathology(id) ON DELETE CASCADE;


--
-- Name: pathology_unit pathology_unit_unit_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.pathology_unit
    ADD CONSTRAINT pathology_unit_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit(id);


--
-- Name: payment_plan payment_plan_condominium_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.payment_plan
    ADD CONSTRAINT payment_plan_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: payment_plan payment_plan_unit_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.payment_plan
    ADD CONSTRAINT payment_plan_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit(id);


--
-- Name: recurring_generation_run recurring_generation_run_condominium_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.recurring_generation_run
    ADD CONSTRAINT recurring_generation_run_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: recurring_template recurring_template_account_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.recurring_template
    ADD CONSTRAINT recurring_template_account_id_fkey FOREIGN KEY (account_id) REFERENCES finance.chart_of_account(id) ON DELETE SET NULL;


--
-- Name: recurring_template recurring_template_condominium_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.recurring_template
    ADD CONSTRAINT recurring_template_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: recurring_template recurring_template_supplier_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.recurring_template
    ADD CONSTRAINT recurring_template_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES core.supplier(id) ON DELETE SET NULL;


--
-- Name: recurring_template recurring_template_unit_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.recurring_template
    ADD CONSTRAINT recurring_template_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit(id);


--
-- Name: supplier suppliers_account_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.supplier
    ADD CONSTRAINT suppliers_account_id_fkey FOREIGN KEY (account_id) REFERENCES finance.chart_of_account(id) ON DELETE SET NULL;


--
-- Name: supplier suppliers_condominium_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.supplier
    ADD CONSTRAINT suppliers_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id) ON DELETE CASCADE;


--
-- Name: ticket_comment ticket_comment_condominium_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.ticket_comment
    ADD CONSTRAINT ticket_comment_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: ticket_comment ticket_comment_ticket_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.ticket_comment
    ADD CONSTRAINT ticket_comment_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES core.ticket(id) ON DELETE CASCADE;


--
-- Name: ticket ticket_condominium_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.ticket
    ADD CONSTRAINT ticket_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: ticket ticket_pathology_id_fk; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.ticket
    ADD CONSTRAINT ticket_pathology_id_fk FOREIGN KEY (pathology_id) REFERENCES core.pathology(id) ON DELETE SET NULL;


--
-- Name: ticket ticket_reported_by_occupant_fk; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.ticket
    ADD CONSTRAINT ticket_reported_by_occupant_fk FOREIGN KEY (reported_by_occupant_id) REFERENCES core.occupant(id) ON DELETE SET NULL;


--
-- Name: ticket ticket_unit_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.ticket
    ADD CONSTRAINT ticket_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit(id);


--
-- Name: unit_occupant unit_occupants_occupant_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.unit_occupant
    ADD CONSTRAINT unit_occupants_occupant_id_fkey FOREIGN KEY (occupant_id) REFERENCES core.occupant(id);


--
-- Name: unit_occupant unit_occupants_unit_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.unit_occupant
    ADD CONSTRAINT unit_occupants_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit(id);


--
-- Name: unit units_condominium_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.unit
    ADD CONSTRAINT units_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: bank_account bank_accounts_condominium_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.bank_account
    ADD CONSTRAINT bank_accounts_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: bank_import_batch bank_import_batches_bank_account_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.bank_import_batch
    ADD CONSTRAINT bank_import_batches_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES finance.bank_account(id);


--
-- Name: bank_import_batch bank_import_batches_condominium_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.bank_import_batch
    ADD CONSTRAINT bank_import_batches_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: bank_import_batch bank_import_batches_imported_by_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.bank_import_batch
    ADD CONSTRAINT bank_import_batches_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES core."user"(id);


--
-- Name: bank_transaction bank_transactions_bank_account_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.bank_transaction
    ADD CONSTRAINT bank_transactions_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES finance.bank_account(id);


--
-- Name: bank_transaction bank_transactions_condominium_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.bank_transaction
    ADD CONSTRAINT bank_transactions_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: bank_transaction bank_transactions_import_batch_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.bank_transaction
    ADD CONSTRAINT bank_transactions_import_batch_id_fkey FOREIGN KEY (import_batch_id) REFERENCES finance.bank_import_batch(id);


--
-- Name: bank_transaction bank_tx_reversal_fk; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.bank_transaction
    ADD CONSTRAINT bank_tx_reversal_fk FOREIGN KEY (reversed_by_transaction_id) REFERENCES finance.bank_transaction(id);


--
-- Name: charge charge_account_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.charge
    ADD CONSTRAINT charge_account_id_fkey FOREIGN KEY (account_id) REFERENCES finance.chart_of_account(id) ON DELETE SET NULL;


--
-- Name: charge charge_budget_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.charge
    ADD CONSTRAINT charge_budget_id_fkey FOREIGN KEY (budget_id) REFERENCES core.budget(id);


--
-- Name: charge charge_condominium_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.charge
    ADD CONSTRAINT charge_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: charge charge_recurring_template_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.charge
    ADD CONSTRAINT charge_recurring_template_id_fkey FOREIGN KEY (recurring_template_id) REFERENCES core.recurring_template(id) ON DELETE SET NULL;


--
-- Name: charge charge_supplier_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.charge
    ADD CONSTRAINT charge_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES core.supplier(id) ON DELETE SET NULL;


--
-- Name: charge charge_unit_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.charge
    ADD CONSTRAINT charge_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit(id);


--
-- Name: chart_of_account chart_of_account_condominium_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.chart_of_account
    ADD CONSTRAINT chart_of_account_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: fcr_transfer fcr_transfer_condominium_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.fcr_transfer
    ADD CONSTRAINT fcr_transfer_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: fiscal_year fiscal_year_closed_assembly_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.fiscal_year
    ADD CONSTRAINT fiscal_year_closed_assembly_id_fkey FOREIGN KEY (closed_assembly_id) REFERENCES core.assembly(id);


--
-- Name: fiscal_year fiscal_year_closed_by_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.fiscal_year
    ADD CONSTRAINT fiscal_year_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES core."user"(id);


--
-- Name: fiscal_year fiscal_year_condominium_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.fiscal_year
    ADD CONSTRAINT fiscal_year_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: ledger ledger_condominium_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.ledger
    ADD CONSTRAINT ledger_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: ledger ledger_unit_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.ledger
    ADD CONSTRAINT ledger_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit(id);


--
-- Name: receipt receipt_bank_transaction_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.receipt
    ADD CONSTRAINT receipt_bank_transaction_id_fkey FOREIGN KEY (bank_transaction_id) REFERENCES finance.bank_transaction(id);


--
-- Name: receipt receipt_condominium_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.receipt
    ADD CONSTRAINT receipt_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: receipt_skip receipt_skip_bank_transaction_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.receipt_skip
    ADD CONSTRAINT receipt_skip_bank_transaction_id_fkey FOREIGN KEY (bank_transaction_id) REFERENCES finance.bank_transaction(id);


--
-- Name: receipt_skip receipt_skip_condominium_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.receipt_skip
    ADD CONSTRAINT receipt_skip_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: receipt_skip receipt_skip_unit_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.receipt_skip
    ADD CONSTRAINT receipt_skip_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit(id);


--
-- Name: receipt receipt_unit_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.receipt
    ADD CONSTRAINT receipt_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit(id);


--
-- Name: settlement settlement_condominium_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.settlement
    ADD CONSTRAINT settlement_condominium_id_fkey FOREIGN KEY (condominium_id) REFERENCES core.condominium(id);


--
-- Name: settlement settlement_credit_charge_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.settlement
    ADD CONSTRAINT settlement_credit_charge_id_fkey FOREIGN KEY (credit_charge_id) REFERENCES finance.charge(id);


--
-- Name: settlement settlement_debit_charge_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.settlement
    ADD CONSTRAINT settlement_debit_charge_id_fkey FOREIGN KEY (debit_charge_id) REFERENCES finance.charge(id);


--
-- Name: settlement settlement_reversed_by_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.settlement
    ADD CONSTRAINT settlement_reversed_by_fkey FOREIGN KEY (reversed_by) REFERENCES finance.settlement(id);


--
-- Name: settlement settlement_unit_id_fkey; Type: FK CONSTRAINT; Schema: finance; Owner: -
--

ALTER TABLE ONLY finance.settlement
    ADD CONSTRAINT settlement_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit(id);


--
-- Name: audit_attach_on_create; Type: EVENT TRIGGER; Schema: -; Owner: -
--

CREATE EVENT TRIGGER audit_attach_on_create ON ddl_command_end
         WHEN TAG IN ('CREATE TABLE')
   EXECUTE FUNCTION audit.fn_attach_on_create();

--
-- Dados de referência
--

INSERT INTO audit.cdc_skip_list (schema_name, table_name, reason)
VALUES
  ('audit', 'email_log', 'email_log é audit log próprio - evita recursão CDC'),
  ('audit', 'cdc_log', 'cdc_log é o próprio destino - nunca auto-loga')
ON CONFLICT (schema_name, table_name) DO NOTHING;
