// DELETE /assemblies/:assemblyId/agenda-items/:agendaItemId - soft-delete, só em `draft`.
// Apagar o ponto aprovador de um budget NÃO reverte o budget para draft (reversão é outro
// fluxo); fica o gap aceitável "budget aprovado sem deliberação ativa" (ela só é soft-deleted).

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { canEditAgenda } from "$shared/assembly/lifecycle.ts";

export const deleteAssemblyAgendaItem = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const assemblyId = ctx.req.param("assemblyId");
  const agendaItemId = ctx.req.param("agendaItemId");
  if (!assemblyId || !agendaItemId) {
    throw new AppError({
      message: "assemblyId e agendaItemId são obrigatórios",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const assemblyResult = await postgres.query((db) =>
    db.query.assembly.findFirst({
      where: byIdInCondo(schema.assembly, assemblyId, condominiumId),
    })
  );
  const assembly = findEntityOrFail(assemblyResult, "Assembleia");

  // Remover um ponto da ordem do dia só em RASCUNHO (mesma regra do create:
  // o que foi convocado não muda por baixo dos condóminos). Ver
  // $shared/assembly/lifecycle.ts.
  if (!canEditAgenda(assembly.status)) {
    throw new AppError({
      message: "A ordem do dia só pode ser alterada com a assembleia em rascunho.",
      statusCode: STATUS_CODE.Conflict,
      code: "AGENDA_LOCKED",
    });
  }

  const decisionResult = await postgres.query((db) =>
    db.query.assemblyAgendaItem.findFirst({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, agendaItemId),
          ops.eq(e.assemblyId, assemblyId),
          ops.isNull(e.deletedAt),
        ),
    })
  );
  findEntityOrFail(decisionResult, "Deliberação");

  await postgres.query((db) =>
    db.update(schema.assemblyAgendaItem)
      .set({ deletedAt: new Date(), deletedBy: actor })
      .where(and(
        eq(schema.assemblyAgendaItem.id, agendaItemId),
        eq(schema.assemblyAgendaItem.assemblyId, assemblyId),
        isNull(schema.assemblyAgendaItem.deletedAt),
      ))
      .returning()
  );

  return new Response(null, { status: STATUS_CODE.NoContent });
};
