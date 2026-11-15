import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { DOCUMENT_PROJECTION, formatDocumentForResponse } from "./_projection.ts";
import { formatDocumentAttachment } from "./attachments.ts";
import { buildDocumentDetailWhere } from "./_query.ts";

export const getDocument = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const documentId = requireParam(ctx, "documentId");

  const result = await postgres.query((db) =>
    db.query.document.findFirst({
      where: buildDocumentDetailWhere({
        documentId,
        condominiumId,
        scope: "all",
      }),
      ...DOCUMENT_PROJECTION,
    })
  );

  const doc = findEntityOrFail(result, "Documento");

  // Anexos via core.attachment polimórfico (entity_type='document').
  const attachments = await postgres.query((db) =>
    db.query.attachment.findMany({
      where: (a, ops) =>
        ops.and(
          ops.eq(a.condominiumId, condominiumId),
          ops.eq(a.entityType, "document"),
          ops.eq(a.entityId, documentId),
          ops.isNull(a.deletedAt),
        ),
      orderBy: (a, ops) => [ops.desc(a.createdAt)],
    })
  );

  return ctx.json({
    data: {
      ...formatDocumentForResponse(doc),
      attachments: attachments.map(formatDocumentAttachment),
    },
  });
};
