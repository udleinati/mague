// GET /v1/admin/condominiums/:cid/occupants
//   ?isActive=true|false → filtra a coluna `is_active` (default: sem filtro)
//   ?ids=a,b,c           → restringe a estes occupants (CSV de IDs).
//                           Usado para enriquecer recibos com preferências
//                           atuais dos recipients do snapshot.
//   ?userId=X            → filtra por core.user.id (resolve "qual occupant
//                           representa este user no condo?"). Usado pelo
//                           detalhe de ticket para mostrar o nome do
//                           submitter via `submittedBy.userId`.
//   ?limit=N             → cap no nº de linhas devolvidas (default 500, max 1000)
//
// Nota: o filtro por tipo (owner/tenant/resident) vive em
// `unit_occupant.relationship_type` - ADR 0018. Use `listUnitOccupants` ou
// agregue no caller a partir do nested.

import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { parseLimit } from "$api/libs/shared/pagination.ts";
import { eqIf, inListIf, listWhere } from "$api/libs/shared/list_query.ts";
import { formatOccupantForResponse, OCCUPANT_PROJECTION } from "./_projection.ts";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

export const listOccupants = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const { isActive: isActiveRaw, ids: idsRaw, userId, limit: limitRaw } = ctx.req.query();
  // `isActive` só aceita "true"/"false"; qualquer outro valor = sem filtro.
  const isActive = isActiveRaw === "true" ? true : isActiveRaw === "false" ? false : null;
  // `ids` distingue 3 estados: ausente (sem filtro), `""` (nenhum → resposta
  // vazia) e CSV (filtra). `?ids=` NÃO pode cair em "sem filtro" - anti-IDOR.
  const ids = idsRaw !== undefined ? idsRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const limit = parseLimit(limitRaw, { default: DEFAULT_LIMIT, max: MAX_LIMIT });

  // Filtro `ids` vazio → resposta vazia sem chegar à DB.
  if (ids && ids.length === 0) {
    return ctx.json({ data: [] });
  }

  const result = await postgres.query((db) =>
    db.query.occupant.findMany({
      where: listWhere(
        schema.occupant,
        condominiumId,
        isActive !== null ? eq(schema.occupant.isActive, isActive) : undefined,
        ids ? inListIf(schema.occupant.id, ids) : undefined,
        eqIf(schema.occupant.userId, userId),
      ),
      orderBy: (e, ops) => ops.asc(e.name),
      limit,
      ...OCCUPANT_PROJECTION,
    })
  );

  const data = result.map(formatOccupantForResponse);
  return ctx.json({ data });
};
