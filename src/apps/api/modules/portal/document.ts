// Portal: documentos públicos do condomínio.
//
// Read-only. Apenas `is_public=true` aparece - enforcado via `scope: "public"`
// nos builders partilhados com o admin. Multi-tenant via cid no path +
// middleware `requirePortalAccessToCondo` upstream.

import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import type { DocumentCategory } from "$api/libs/postgres/schemas/document.ts";
import {
  DOCUMENT_PROJECTION,
  formatDocumentForResponse,
} from "$api/modules/admin/document/_projection.ts";
import {
  buildDocumentListOrderBy,
  buildDocumentListWhere,
} from "$api/modules/admin/document/_query.ts";
import { formatDocumentAttachment } from "$api/modules/admin/document/attachments.ts";

export const portalListDocuments = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const { category } = ctx.req.query();

  const result = await postgres.query((db) =>
    db.query.document.findMany({
      where: buildDocumentListWhere({
        condominiumId,
        scope: "public",
        category: (category ?? null) as DocumentCategory | null,
      }),
      orderBy: buildDocumentListOrderBy(),
      limit: 500,
      ...DOCUMENT_PROJECTION,
    })
  );

  // Attachments de todos os docs numa única query: a lista mostra ícone de tipo,
  // count de ficheiros e download direto do anexo único sem ir ao detalhe.
  const docIds = result.map((d) => d.id).filter((id): id is string => !!id);
  const attachmentsByDoc = new Map<string, ReturnType<typeof formatDocumentAttachment>[]>();
  if (docIds.length > 0) {
    const allAttachments = await postgres.query((db) =>
      db.query.attachment.findMany({
        where: (a, ops) =>
          ops.and(
            ops.eq(a.condominiumId, condominiumId),
            ops.eq(a.entityType, "document"),
            ops.inArray(a.entityId, docIds),
            ops.isNull(a.deletedAt),
          ),
        orderBy: (a, ops) => [ops.asc(a.createdAt)],
      })
    );
    for (const a of allAttachments) {
      const list = attachmentsByDoc.get(a.entityId) ?? [];
      list.push(formatDocumentAttachment(a));
      attachmentsByDoc.set(a.entityId, list);
    }
  }

  const data = result.map((doc) => ({
    ...formatDocumentForResponse(doc),
    attachments: attachmentsByDoc.get(doc.id ?? "") ?? [],
  }));
  return ctx.json({ data });
};
