// Attachments para charges (faturas/recibos/comprovativos).
//
// Configuração mínima do `EntityAttachmentManager` - toda a lógica
// (multipart parse, ownership check, response shape) vive em
// `libs/attachments/manager.ts`.

import { makeAttachmentManager } from "$api/libs/attachments/manager.ts";
import type { AttachmentSelect } from "$api/libs/postgres/schemas/attachment.ts";

const manager = makeAttachmentManager({
  entityType: "charge",
  paramName: "chargeId",
  entityNamePT: "Charge",
  defaultFilename: "fatura",
  ownershipQuery: (postgres, chargeId, condominiumId) =>
    postgres.query((db) =>
      db.query.charge.findFirst({
        where: (c, ops) =>
          ops.and(
            ops.eq(c.id, chargeId),
            ops.eq(c.condominiumId, condominiumId),
          ),
      })
    ),
  serialize: (a: AttachmentSelect) => ({
    id: a.id,
    chargeId: a.entityId,
    filename: a.filename,
    mimeType: a.mimeType,
    fileSize: a.fileSize,
    createdAt: a.createdAt,
    createdBy: a.createdBy,
  }),
});

export const listChargeAttachmentsHandler = manager.list;
export const uploadChargeAttachmentHandler = manager.upload;
export const serveChargeAttachmentHandler = manager.serve;
export const deleteChargeAttachmentHandler = manager.delete;
