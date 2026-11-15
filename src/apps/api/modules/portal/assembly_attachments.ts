// Portal: anexos de assembleias públicas (status != 'draft'). O `ownershipQuery`
// com filtro de visibilidade corre ANTES de servir bytes (anti-IDOR, ADR 0003) -
// o handler admin não filtra draft, por isso o portal NÃO o reutiliza (mesmo
// padrão de portal/pathology_attachments.ts). Só list + serve; writes são admin.

import { makeAttachmentManager } from "$api/libs/attachments/manager.ts";
import { ASSEMBLY_PUBLIC_STATUSES } from "$api/libs/enums.ts";
import { formatAssemblyAttachmentForResponse } from "$api/modules/admin/assembly/attachments.ts";

const portalAssemblyAttachments = makeAttachmentManager({
  entityType: "assembly",
  paramName: "assemblyId",
  entityNamePT: "Assembleia",
  ownershipQuery: (postgres, assemblyId, condominiumId) =>
    postgres.query((db) =>
      db.query.assembly.findFirst({
        where: (a, ops) =>
          ops.and(
            ops.eq(a.id, assemblyId),
            ops.eq(a.condominiumId, condominiumId),
            ops.isNull(a.deletedAt),
            ops.inArray(a.status, [...ASSEMBLY_PUBLIC_STATUSES]),
          ),
      })
    ),
  serialize: formatAssemblyAttachmentForResponse,
});

export const portalListAssemblyAttachmentsHandler = portalAssemblyAttachments.list;
export const portalServeAssemblyAttachmentHandler = portalAssemblyAttachments.serve;
