// Portal: serve fotos de patologias `status != 'draft'`. `ownershipQuery`
// (ADR 0024) gating por status corre ANTES de servir bytes: uma `draft` nunca
// expõe fotos (anti-IDOR). Só `serve`; upload/delete são admin.

import { makeAttachmentManager } from "$api/libs/attachments/manager.ts";
import type { AttachmentSelect } from "$api/libs/postgres/schemas/attachment.ts";
import { PATHOLOGY_PUBLIC_STATUSES } from "$api/libs/postgres/schemas/pathology.ts";
import { formatPathologyAttachmentForResponse } from "$api/modules/admin/pathology/_projection.ts";

const portalPathologyAttachments = makeAttachmentManager({
  entityType: "pathology",
  paramName: "pathologyId",
  entityNamePT: "Patologia",
  ownershipQuery: (postgres, pathologyId, condominiumId) =>
    postgres.query((db) =>
      db.query.pathology.findFirst({
        where: (p, ops) =>
          ops.and(
            ops.eq(p.id, pathologyId),
            ops.eq(p.condominiumId, condominiumId),
            ops.isNull(p.deletedAt),
            // ADR 0024: patologia pública == status != 'draft'.
            ops.inArray(p.status, [...PATHOLOGY_PUBLIC_STATUSES]),
          ),
      })
    ),
  serialize: (a: AttachmentSelect) => formatPathologyAttachmentForResponse(a),
});

export const portalServePathologyAttachmentHandler = portalPathologyAttachments.serve;
