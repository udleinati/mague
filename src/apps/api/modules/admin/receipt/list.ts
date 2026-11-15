// GET /v1/admin/condominiums/:cid/receipts?year=2026&unitId=...&voided=true|false
//   ?limit=N           → cap no nº de linhas (default 1000, max 2000)
//   ?withMeta=1        → resposta inclui meta { availableYears }
//   ?page=N&perPage=N  → paginação (default perPage 500, cap 1000)

import type { Context } from "hono";
import { desc, eq, isNotNull, isNull } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { parseLimit, parsePageParams } from "$api/libs/shared/pagination.ts";
import { buildPaginationMeta, countWhere, eqIf, listWhere } from "$api/libs/shared/list_query.ts";
import { formatReceiptForResponse, RECEIPT_PROJECTION } from "./_projection.ts";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 2000;

export const listReceipts = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const yearStr = ctx.req.query("year");
  const unitId = ctx.req.query("unitId");
  const voidedFilter = ctx.req.query("voided"); // "true" | "false" | undefined
  const withMeta = ctx.req.query("withMeta");
  const year = yearStr ? Number(yearStr) : null;
  const limit = parseLimit(ctx.req.query("limit"), { default: DEFAULT_LIMIT, max: MAX_LIMIT });
  const pp = parsePageParams(
    ctx.req.query("page"),
    ctx.req.query("perPage"),
    { defaultPerPage: 500, maxPerPage: 1000 },
  );
  const isPaginated = pp.page !== null;
  const sliceLimit = isPaginated ? pp.perPage : limit;

  // WHERE único para findMany + count - tenant scope por construção.
  const where = listWhere(
    schema.receipt,
    condominiumId,
    year != null ? eq(schema.receipt.year, year) : undefined,
    eqIf(schema.receipt.unitId, unitId),
    voidedFilter === "true" ? isNotNull(schema.receipt.voidedAt) : undefined,
    voidedFilter === "false" ? isNull(schema.receipt.voidedAt) : undefined,
  );

  const rows = await postgres.query((db) =>
    db.query.receipt.findMany({
      where,
      orderBy: (r, { desc }) => [desc(r.issuedAt)],
      limit: sliceLimit,
      offset: isPaginated ? pp.offset : undefined,
      ...RECEIPT_PROJECTION,
    })
  );

  const data = rows.map((row) => formatReceiptForResponse(row));

  const pagination = isPaginated
    ? buildPaginationMeta(pp, await countWhere(postgres, schema.receipt, where))
    : undefined;

  if (withMeta !== "1" && withMeta !== "true") {
    return ctx.json(pagination ? { data, pagination } : { data });
  }

  // availableYears: anos com recibos no condomínio (sem filtros - dropdown).
  // `year` já é integer - selectDistinct direto, sem o EXTRACT do helper.
  const yearsRes = await postgres.query((db) =>
    db.selectDistinct({ year: schema.receipt.year })
      .from(schema.receipt)
      .where(listWhere(schema.receipt, condominiumId, isNotNull(schema.receipt.year)))
      .orderBy(desc(schema.receipt.year))
  );
  const availableYears = yearsRes.map((r) => Number(r.year)).filter((y) => Number.isFinite(y));

  return ctx.json({
    data,
    meta: { availableYears },
    ...(pagination ? { pagination } : {}),
  });
};
