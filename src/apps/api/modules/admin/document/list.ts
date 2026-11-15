// GET /v1/admin/condominiums/:cid/documents
//   ?category=minutes|… → filtra por categoria
//   ?isPublic=true|false → filtra visibilidade
//   ?limit=N             → cap (default 500, max 1000)

import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { parseLimit } from "$api/libs/shared/pagination.ts";
import type { DocumentCategory } from "$api/libs/postgres/schemas/document.ts";
import { DOCUMENT_PROJECTION, formatDocumentForResponse } from "./_projection.ts";
import { buildDocumentListOrderBy, buildDocumentListWhere } from "./_query.ts";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

export const listDocuments = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const { category, isPublic: isPublicRaw, limit: limitRaw } = ctx.req.query();
  const isPublic = isPublicRaw === "true" ? true : isPublicRaw === "false" ? false : null;
  const limit = parseLimit(limitRaw, { default: DEFAULT_LIMIT, max: MAX_LIMIT });

  const result = await postgres.query((db) =>
    db.query.document.findMany({
      where: buildDocumentListWhere({
        condominiumId,
        scope: "all",
        category: (category ?? null) as DocumentCategory | null,
        isPublic,
      }),
      orderBy: buildDocumentListOrderBy(),
      limit,
      ...DOCUMENT_PROJECTION,
    })
  );

  return ctx.json({ data: result.map(formatDocumentForResponse) });
};
