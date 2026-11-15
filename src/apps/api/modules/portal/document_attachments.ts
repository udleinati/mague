// Portal: serve anexos de documentos PÚBLICOS. `ownershipQuery` filtra
// `is_public=true` antes de servir bytes (anti-IDOR: docs privados nunca expõem
// anexos). Só `serve`; upload/delete são admin.

import { makeAttachmentManager } from "$api/libs/attachments/manager.ts";
import { formatDocumentAttachment } from "$api/modules/admin/document/attachments.ts";
import type { AttachmentSelect } from "$api/libs/postgres/schemas/attachment.ts";

const portalDocumentAttachments = makeAttachmentManager({
  entityType: "document",
  paramName: "documentId",
  entityNamePT: "Documento",
  ownershipQuery: (postgres, documentId, condominiumId) =>
    postgres.query((db) =>
      db.query.document.findFirst({
        where: (d, ops) =>
          ops.and(
            ops.eq(d.id, documentId),
            ops.eq(d.condominiumId, condominiumId),
            ops.eq(d.isPublic, true),
            ops.isNull(d.deletedAt),
          ),
      })
    ),
  serialize: (a: AttachmentSelect) => formatDocumentAttachment(a),
});

export const portalServeDocumentAttachmentHandler = portalDocumentAttachments.serve;
