-- 013_audit.sql - Audit genérico (ADR 0011). UMA fn_log_change() attached a
-- todas as tabelas core/finance (event trigger em CREATE TABLE + bootstrap no
-- fim). Actor de NEW.{created,updated,deleted}_by, fallback GUC app.user_id;
-- tenant de NEW.condominium_id, fallback GUC. audit.cdc_log é imutável (secção 4).

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Função do trigger genérica
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION audit.fn_log_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
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

COMMENT ON FUNCTION audit.fn_log_change() IS
  'Trigger AFTER INSERT/UPDATE/DELETE genérico. SECURITY DEFINER: insere em audit.cdc_log mesmo com REVOKE para PUBLIC.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Helper de attach a uma tabela
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION audit.fn_attach_to_table(p_schema text, p_table text)
RETURNS void
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

COMMENT ON FUNCTION audit.fn_attach_to_table(text, text) IS
  'Attach audit.fn_log_change a uma tabela. Idempotente. Respeita skip_list e ignora partitions filhas.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Event trigger DDL: attach automático em CREATE TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION audit.fn_attach_on_create()
RETURNS event_trigger
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

DROP EVENT TRIGGER IF EXISTS audit_attach_on_create;
CREATE EVENT TRIGGER audit_attach_on_create
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE')
  EXECUTE FUNCTION audit.fn_attach_on_create();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Imutabilidade de audit.cdc_log
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION audit.fn_reject_modification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit.cdc_log is append-only (% rejected on %.%)',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_log_no_update ON audit.cdc_log;
CREATE TRIGGER trg_audit_log_no_update
  BEFORE UPDATE ON audit.cdc_log
  FOR EACH ROW EXECUTE FUNCTION audit.fn_reject_modification();

DROP TRIGGER IF EXISTS trg_audit_log_no_delete ON audit.cdc_log;
CREATE TRIGGER trg_audit_log_no_delete
  BEFORE DELETE ON audit.cdc_log
  FOR EACH ROW EXECUTE FUNCTION audit.fn_reject_modification();

DROP TRIGGER IF EXISTS trg_audit_log_no_truncate ON audit.cdc_log;
CREATE TRIGGER trg_audit_log_no_truncate
  BEFORE TRUNCATE ON audit.cdc_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit.fn_reject_modification();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. Bootstrap: attach a todas as tabelas existentes em core/finance
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('core', 'finance')
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
  LOOP
    PERFORM audit.fn_attach_to_table(r.schema_name, r.table_name);
  END LOOP;
END $$;
