import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { softDeleteAttachmentsForEntity } from "$api/libs/attachments/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const deleteDocument = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const documentId = requireParam(ctx, "documentId");

  const existing = await postgres.query((db) =>
    db.query.document.findFirst({
      where: byIdInCondo(schema.document, documentId, condominiumId),
    })
  );
  findEntityOrFail(existing, "Documento");

  const actor = requireActor(ctx);

  // Cascata S3 aos anexos PRIMEIRO, depois soft-delete (ADR 0021).
  await softDeleteAttachmentsForEntity({
    postgres,
    condominiumId,
    entityType: "document",
    entityId: documentId,
    actor,
  });

  await postgres.query((db) =>
    db.update(schema.document)
      .set({ deletedAt: new Date(), updatedAt: new Date(), deletedBy: actor })
      .where(byIdInCondo(schema.document, documentId, condominiumId))
  );

  return new Response(null, { status: STATUS_CODE.NoContent });
};
