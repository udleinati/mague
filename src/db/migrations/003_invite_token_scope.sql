-- 003_invite_token_scope.sql
-- Âmbito de quem convidou, gravado no convite. O aceite volta a validar a conta
-- contra ele: o link fica no email_log e no BCC do condomínio, e entre o envio
-- e o aceite a conta pode ter passado a abrir outro condomínio.
-- NULL = sem limite (convite de super; tokens de reset).

ALTER TABLE core.invite_token ADD COLUMN scope_condominium_ids text[];

COMMENT ON COLUMN core.invite_token.scope_condominium_ids IS 'Condomínios geridos por quem convidou. O aceite recusa se a conta abrir algum fora daqui. NULL = sem limite.';

-- Convites por abrir: âmbito = condomínios onde a conta é ocupante (o motivo do
-- convite). Mais apertado que o original no pior caso: pede-se novo convite.
UPDATE core.invite_token t
SET scope_condominium_ids = ARRAY(
  SELECT DISTINCT o.condominium_id
  FROM core.occupant o
  WHERE o.user_id = t.user_id AND o.deleted_at IS NULL
)
WHERE t.purpose = 'invite' AND t.used_at IS NULL AND t.expires_at > now();
