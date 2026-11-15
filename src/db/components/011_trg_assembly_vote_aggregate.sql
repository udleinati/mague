-- 011_trg_assembly_vote_aggregate.sql
--
-- Trigger AFTER INSERT/UPDATE/DELETE em `core.assembly_vote` que re-agrega
-- os totais em `core.assembly_agenda_item.votes_in_favor`/`votes_against`/
-- `votes_abstain`. Estes campos continuam a existir para queries rápidas
-- (e para preservar API compat) mas agora derivam **automaticamente** das
-- linhas de `assembly_vote`.
--
-- Idempotente: re-aplica via DROP IF EXISTS + CREATE.
-- Em trigger (não TS, ADR 0001): garante a nível de DB que os agregados nunca
-- divergem dos votos individuais, sem depender de cada call site.

DROP TRIGGER IF EXISTS trg_assembly_vote_aggregate_aiud ON core.assembly_vote;
DROP FUNCTION IF EXISTS core.fn_assembly_vote_aggregate();

CREATE OR REPLACE FUNCTION core.fn_assembly_vote_aggregate()
RETURNS trigger
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

CREATE TRIGGER trg_assembly_vote_aggregate_aiud
  AFTER INSERT OR UPDATE OR DELETE ON core.assembly_vote
  FOR EACH ROW
  EXECUTE FUNCTION core.fn_assembly_vote_aggregate();
