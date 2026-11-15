// GET /v1/admin/c/:cid/pathologies - lista patologias do condomínio.
// Filtro opcional `?status=` (e.g. status=draft, status=in_repair).
//
// Query partilhada com o portal via `_query.ts` (padrão ADR 0003) -
// admin usa `scope: "all"`, portal `scope: "public"`.

import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import type { PathologyStatus } from "$api/libs/postgres/schemas/pathology.ts";
import { formatPathologyForResponse, PATHOLOGY_PROJECTION } from "./_projection.ts";
import { buildPathologyListOrderBy, buildPathologyListWhere } from "./_query.ts";

export const listPathologies = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const url = new URL(ctx.req.url);
  const status = url.searchParams.get("status") ?? undefined;

  const rows = await postgres.query((db) =>
    db.query.pathology.findMany({
      where: buildPathologyListWhere({
        condominiumId,
        scope: "all",
        status: (status ?? null) as PathologyStatus | null,
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
