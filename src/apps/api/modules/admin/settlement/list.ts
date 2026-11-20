// GET /v1/admin/c/:cid/settlements
//   ?bankTransactionId=…  filtra pelo(s) movimento(s) bancário(s) (CSV de IDs);
//                         presente-mas-vazio → resposta vazia (não "todos").
//   ?unitId=…             filtra pela fração (sujeito a `assertUserCanAccessUnit`)
//   ?chargeId=…           settlements em que a charge é uma das pontas
//   ?dateFrom=YYYY-MM-DD  filtra `settlement_date >= dateFrom`
//   ?dateTo=YYYY-MM-DD    filtra `settlement_date <= dateTo`
//   ?limit=N              cap (default 1000, max 5000)
//
// Lista settlements (conciliações) do condomínio: o que cada movimento bancário
// reconciliou e o histórico de pagamentos por fração (portal do owner).

import type { Context } from "hono";
import { eq, or, sql } from "drizzle-orm";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { isCondoAdmin } from "$api/libs/shared/require_condo_admin.ts";
import { parseLimit } from "$api/libs/shared/pagination.ts";
import { dateRange, inListIf, listWhere } from "$api/libs/shared/list_query.ts";
import { assertUserCanAccessUnit } from "$api/libs/shared/assert_ownership.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatSettlementForResponse, SETTLEMENT_PROJECTION } from "./_projection.ts";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

export const listSettlements = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  // `bankTransactionId` distingue 3 estados: ausente (sem filtro), presente-mas-
  // vazio (resposta vazia) e CSV (filtra) - a página de conciliação passa os IDs
  // dos movimentos da página visível, em vez de puxar todos os settlements.
  const bankTxRaw = ctx.req.query("bankTransactionId");
  const bankTxIds = bankTxRaw !== undefined
    ? bankTxRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const unitFilter = ctx.req.query("unitId") ?? null;
  const chargeFilter = ctx.req.query("chargeId") ?? null;
  const dateFrom = ctx.req.query("dateFrom") ?? null;
  const dateTo = ctx.req.query("dateTo") ?? null;
  const limit = parseLimit(ctx.req.query("limit"), { default: DEFAULT_LIMIT, max: MAX_LIMIT });

  // ── Auth gate ────────────────────────────────────────────────────────
  // Idem charges: occupant tem de filtrar por `?unitId=` (e o auth gate
  // valida que pode aceder a essa unit). Super OU manager deste cid
  // (derivado de managedCondominiumIds - ADR 0002) listam tudo.
  const isAdmin = isCondoAdmin(ctx);
  if (unitFilter) {
    await assertUserCanAccessUnit(ctx, postgres, unitFilter, condominiumId);
  } else if (!isAdmin) {
    throw new AppError({
      message: "unitId é obrigatório para callers que não são admin",
      statusCode: STATUS_CODE.Forbidden,
      code: "UNIT_ID_REQUIRED",
    });
  }

  // Filtro `bankTransactionId` presente-mas-vazio → resposta vazia sem ir à DB
  // (evita o full-fetch acidental de um param vazio).
  if (bankTxIds && bankTxIds.length === 0) {
    return ctx.json({ data: [] });
  }

  // WHERE via módulo de list query - tenant scope por construção.
  const where = listWhere(
    schema.settlement,
    condominiumId,
    bankTxIds ? inListIf(schema.settlement.bankTransactionId, bankTxIds) : undefined,
    // Filtro inclusivo: settlement alocada à unit OU ligada a uma charge dessa
    // unit (EXISTS por charge.id). Substitui o cruzamento em JS do portal.
    unitFilter
      ? or(
        eq(schema.settlement.unitId, unitFilter),
        sql`EXISTS (
          SELECT 1 FROM finance.charge c
           WHERE c.id IN (${schema.settlement.debitChargeId}, ${schema.settlement.creditChargeId})
             AND c.unit_id = ${unitFilter}
        )`,
      )
      : undefined,
    chargeFilter
      ? or(
        eq(schema.settlement.debitChargeId, chargeFilter),
        eq(schema.settlement.creditChargeId, chargeFilter),
      )
      : undefined,
    dateRange(schema.settlement.settlementDate, dateFrom, dateTo),
  );

  const result = await postgres.query((db) =>
    db.query.settlement.findMany({
      where,
      orderBy: (e, ops) => [ops.desc(e.settlementDate), ops.desc(e.createdAt)],
      // Nested debitCharge/creditCharge/bankTransaction (subset estável).
      ...SETTLEMENT_PROJECTION,
      limit,
    })
  );

  const data = result.map(formatSettlementForResponse);
  return ctx.json({ data });
};
