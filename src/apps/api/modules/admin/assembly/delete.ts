import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { softDeleteAttachmentsForEntity } from "$api/libs/attachments/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { canEditAgenda, canRecordMeeting } from "$shared/assembly/lifecycle.ts";

export const deleteAssembly = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const assemblyId = requireParam(ctx, "assemblyId");

  const existing = await postgres.query((db) =>
    db.query.assembly.findFirst({
      where: byIdInCondo(schema.assembly, assemblyId, condominiumId),
    })
  );
  const data = findEntityOrFail(existing, "Assembleia");

  // Lock: assembleias realizadas/canceladas não podem ser apagadas (fazem
  // parte do histórico oficial). Em rascunho ou convocada ainda podem.
  // Ver $shared/assembly/lifecycle.ts.
  if (!canEditAgenda(data.status) && !canRecordMeeting(data.status)) {
    throw new AppError({
      message: "Assembleia já foi realizada ou cancelada - não é possível apagar.",
      statusCode: STATUS_CODE.Conflict,
      code: "ASSEMBLY_LOCKED",
    });
  }

  // Cascata S3 aos anexos PRIMEIRO, depois soft-delete da assembleia (ADR 0021).
  await softDeleteAttachmentsForEntity({
    postgres,
    condominiumId,
    entityType: "assembly",
    entityId: assemblyId,
    actor,
  });

  await postgres.query((db) =>
    db.update(schema.assembly)
      .set({ deletedAt: new Date(), deletedBy: actor, updatedAt: new Date(), updatedBy: actor })
      .where(byIdInCondo(schema.assembly, assemblyId, condominiumId))
      .returning()
  );

  return new Response(null, { status: STATUS_CODE.NoContent });
};
