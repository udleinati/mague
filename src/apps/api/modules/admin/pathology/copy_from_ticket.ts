// POST .../pathologies/:pathologyId/copy-attachments-from-ticket  body: { ticketId }
// DUPLICA os attachments de um ticket para a patologia (fluxo "promover ticket a
// patologia"): cópias independentes, apagar a patologia NÃO afeta o ticket original.
// NÃO idempotente: cada chamada duplica de novo (novos ids/S3 keys).

import type { Context } from "hono";
import { z } from "zod";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { copyAttachmentsToEntity } from "$api/libs/attachments/mod.ts";

const bodySchema = z.object({
  ticketId: z.string().min(1),
});

export const copyAttachmentsFromTicket = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const pathologyId = requireParam(ctx, "pathologyId");
  const body = await dtoValidator(bodySchema, await ctx.req.json());
  const actor = requireActor(ctx);

  // Anti-IDOR: ambos pertencem a este condo + não estão soft-deleted.
  const [pathology, ticket] = await Promise.all([
    postgres.query((db) =>
      db.query.pathology.findFirst({
        where: byIdInCondo(schema.pathology, pathologyId, condominiumId),
        columns: { id: true },
      })
    ),
    postgres.query((db) =>
      db.query.ticket.findFirst({
        where: byIdInCondo(schema.ticket, body.ticketId, condominiumId),
        columns: { id: true },
      })
    ),
  ]);
  findEntityOrFail(pathology, "Patologia");
  findEntityOrFail(ticket, "Ocorrência");

  const result = await copyAttachmentsToEntity({
    postgres,
    condominiumId,
    source: { entityType: "ticket", entityId: body.ticketId },
    target: { entityType: "pathology", entityId: pathologyId },
    actor,
  });

  if (result.failed > 0 && result.copied === 0) {
    throw new AppError({
      message: `Nenhum anexo foi copiado (${result.total} tentados, todos falharam)`,
      statusCode: STATUS_CODE.InternalServerError,
      code: "COPY_FAILED",
    });
  }

  return ctx.json({ data: result });
};
