// Portal: patologias do edifício (read-only). Só `status != 'draft'` via
// `scope: "public"` (ADR 0003 + ADR 0024). Sem `tickets[]` (evita leak cross-fração).

import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import {
  formatPathologyForResponse,
  PATHOLOGY_PROJECTION,
} from "$api/modules/admin/pathology/_projection.ts";
import {
  buildPathologyDetailWhere,
  buildPathologyListOrderBy,
  buildPathologyListWhere,
  type PathologyStatusGroup,
} from "$api/modules/admin/pathology/_query.ts";
import { listPathologyAttachments } from "$api/modules/admin/pathology/_helpers.ts";

const VALID_STATUS_GROUPS: ReadonlySet<PathologyStatusGroup> = new Set([
  "active",
  "resolved",
  "dismissed",
]);

function parseStatusGroup(raw: string | null | undefined): PathologyStatusGroup | null {
  if (!raw) return null;
  return VALID_STATUS_GROUPS.has(raw as PathologyStatusGroup)
    ? (raw as PathologyStatusGroup)
    : null;
}

export const portalListPathologies = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const url = new URL(ctx.req.url);
  const statusGroup = parseStatusGroup(url.searchParams.get("statusGroup"));

  const rows = await postgres.query((db) =>
    db.query.pathology.findMany({
      where: buildPathologyListWhere({
        condominiumId,
        scope: "public",
        statusGroup,
      }),
      orderBy: buildPathologyListOrderBy(),
      ...PATHOLOGY_PROJECTION,
      with: {
        units: {
          with: {
            unit: { columns: { id: true, designation: true, identifier: true } },
          },
        },
      },
    })
  );

  return ctx.json({
    data: rows.map((r) => formatPathologyForResponse(r)),
  });
};

export const portalGetPathology = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const pathologyId = requireParam(ctx, "pathologyId");

  const row = await postgres.query((db) =>
    db.query.pathology.findFirst({
      where: buildPathologyDetailWhere({
        pathologyId,
        condominiumId,
        scope: "public",
      }),
      ...PATHOLOGY_PROJECTION,
      with: {
        units: {
          with: {
            unit: { columns: { id: true, designation: true, identifier: true } },
          },
        },
        // Sem `tickets`: não vazar tickets cross-fração.
      },
    })
  );
  const target = findEntityOrFail(row, "Patologia");

  const attachments = await listPathologyAttachments(postgres, condominiumId, pathologyId);

  return ctx.json({
    data: formatPathologyForResponse({ ...target, attachments }),
  });
};
