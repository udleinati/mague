// Attachments para assembleias (ata em PDF, lista de presenças, anexos pontuais).
// Endpoints: GET/POST /assemblies/:assemblyId/attachments; GET/DELETE .../attachments/:id.

import { makeAttachmentManager } from "$api/libs/attachments/manager.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import type { AttachmentSelect } from "$api/libs/postgres/schemas/attachment.ts";

// ADR 0011: sem `createdBy` (ActorSnapshot nunca sai em respostas da API).
export function formatAssemblyAttachmentForResponse(a: AttachmentSelect) {
  return {
    id: a.id,
    assemblyId: a.entityId,
    filename: a.filename,
    mimeType: a.mimeType,
    fileSize: a.fileSize,
    createdAt: a.createdAt,
  };
}

const manager = makeAttachmentManager({
  entityType: "assembly",
  paramName: "assemblyId",
  entityNamePT: "Assembleia",
  ownershipQuery: (postgres, assemblyId, condominiumId) =>
    postgres.query((db) =>
      db.query.assembly.findFirst({
        where: byIdInCondo(schema.assembly, assemblyId, condominiumId),
      })
    ),
  serialize: formatAssemblyAttachmentForResponse,
});

export const listAssemblyAttachmentsHandler = manager.list;
export const uploadAssemblyAttachmentHandler = manager.upload;
export const serveAssemblyAttachmentHandler = manager.serve;
export const deleteAssemblyAttachmentHandler = manager.delete;
