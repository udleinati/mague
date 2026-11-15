// GET /v1/admin/c/:cid/pathologies/:pathologyId
//
// Where partilhado com o portal via `_query.ts` (padrão ADR 0003).

import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { formatPathologyForResponse, PATHOLOGY_PROJECTION } from "./_projection.ts";
import { buildPathologyDetailWhere } from "./_query.ts";
import { listPathologyAttachments } from "./_helpers.ts";

export const getPathology = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const pathologyId = requireParam(ctx, "pathologyId");

  const row = await postgres.query((db) =>
    db.query.pathology.findFirst({
      where: buildPathologyDetailWhere({
        pathologyId,
        condominiumId,
        scope: "all",
      }),
      ...PATHOLOGY_PROJECTION,
      with: {
        units: {
          with: {
            unit: { columns: { id: true, designation: true, identifier: true } },
          },
        },
        // Tickets associados (ADR 0024): created_at ASC mostra a sequência
        // natural de intervenções (1o o ticket de origem, depois os seguintes).
        tickets: {
          where: (t, ops) => ops.isNull(t.deletedAt),
          orderBy: (t, { asc }) => [asc(t.createdAt)],
          columns: {
            id: true,
            code: true,
            title: true,
            status: true,
            createdAt: true,
          },
        },
      },
    })
  );
  const target = findEntityOrFail(row, "Patologia");

  // Attachments via tabela polimórfica - fetched separadamente (não há relação
  // Drizzle direta entre pathology e attachment).
  const attachments = await listPathologyAttachments(postgres, condominiumId, pathologyId);

  return ctx.json({
    data: formatPathologyForResponse({ ...target, attachments }),
  });
};
