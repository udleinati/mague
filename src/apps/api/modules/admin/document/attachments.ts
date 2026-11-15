// Attachments para documentos (PDFs/imagens): POST (upload), GET (serve bytes),
// DELETE em /documents/:documentId/attachments[/:id].

import { makeAttachmentManager } from "$api/libs/attachments/manager.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import type { AttachmentSelect } from "$api/libs/postgres/schemas/attachment.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";

const manager = makeAttachmentManager({
  entityType: "document",
  paramName: "documentId",
  entityNamePT: "Documento",
  ownershipQuery: (postgres, documentId, condominiumId) =>
    postgres.query((db) =>
      db.query.document.findFirst({
        where: byIdInCondo(schema.document, documentId, condominiumId),
      })
    ),
  serialize: (a: AttachmentSelect) => formatDocumentAttachment(a),
});

export const uploadDocumentAttachmentHandler = manager.upload;
export const serveDocumentAttachmentHandler = manager.serve;
export const deleteDocumentAttachmentHandler = manager.delete;

export function formatDocumentAttachment(row: Partial<AttachmentSelect>) {
  return {
    id: row.id,
    documentId: row.entityId,
    filename: row.filename,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    createdAt: row.createdAt,
  };
}
