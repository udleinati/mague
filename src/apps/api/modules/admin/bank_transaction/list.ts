// GET /v1/admin/condominiums/:cid/bank_transactions
//   ?status=unreconciled[,partial]  → único ou CSV multi-status
//   ?year=YYYY        → EXTRACT(YEAR FROM transaction_date)
//   ?bankAccountId=X  → filtra por conta bancária
//   ?limit=N          → cap (default 500, max 1000)
//   ?withMeta=1       → meta { availableYears }
//   ?withSuggestions=1 → enriquece cada row com suggested{Kind,UnitId,SupplierId,Label}
//                        ou matchConflictCount (keyword matching - ver suggest_match.ts)

import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { parseLimit, parsePageParams } from "$api/libs/shared/pagination.ts";
import {
  buildPaginationMeta,
  countWhere,
  eqIf,
  inListIf,
  listAvailableYears,
  listWhere,
  parseStatusList,
  parseYear,
  yearRange,
} from "$api/libs/shared/list_query.ts";
import { BANK_TRANSACTION_PROJECTION, formatBankTransactionForResponse } from "./_projection.ts";
import { applyMatchSuggestions } from "./suggest_match.ts";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;
const ALLOWED_STATUSES = new Set([
  "unreconciled",
  "partial",
  "reconciled",
  "ignored",
  "reversed",
]);

export const listBankTransactions = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const {
    status,
    year: yearRaw,
    bankAccountId,
    limit: limitRaw,
    withMeta,
    withSuggestions,
    page: pageRaw,
    perPage: perPageRaw,
  } = ctx.req.query();
  const wantSuggestions = withSuggestions === "1" || withSuggestions === "true";
  const year = parseYear(yearRaw);
  const limit = parseLimit(limitRaw, { default: DEFAULT_LIMIT, max: MAX_LIMIT });
  const statusList = parseStatusList(status, ALLOWED_STATUSES);

  const pp = parsePageParams(pageRaw, perPageRaw, { defaultPerPage: 500, maxPerPage: 1000 });
  const isPaginated = pp.page !== null;
  const sliceLimit = isPaginated ? pp.perPage : limit;

  // WHERE único para findMany + count - tenant scope por construção.
  const where = listWhere(
    schema.bankTransaction,
    condominiumId,
    inListIf(schema.bankTransaction.status, statusList),
    eqIf(schema.bankTransaction.bankAccountId, bankAccountId),
    yearRange(schema.bankTransaction.transactionDate, year),
  );

  const result = await postgres.query((db) =>
    db.query.bankTransaction.findMany({
      where,
      orderBy: (e, ops) => ops.desc(e.transactionDate),
      limit: sliceLimit,
      offset: isPaginated ? pp.offset : undefined,
      ...BANK_TRANSACTION_PROJECTION,
    })
  );

  let data = result.map(formatBankTransactionForResponse);

  if (wantSuggestions && data.length > 0) {
    // Units + suppliers para keyword matching. Soft fail: devolve data sem sugestões, não 500.
    try {
      const [units, suppliers] = await Promise.all([
        postgres.query((db) =>
          db.query.unit.findMany({
            where: (e, ops) =>
              ops.and(
                ops.eq(e.condominiumId, condominiumId),
                ops.isNull(e.deletedAt),
                ops.eq(e.isActive, true),
              ),
            columns: { id: true, designation: true, identifier: true, matchKeywords: true },
          })
        ),
        postgres.query((db) =>
          db.query.supplier.findMany({
            where: (e, ops) =>
              ops.and(ops.eq(e.condominiumId, condominiumId), ops.isNull(e.deletedAt)),
            columns: { id: true, name: true, matchKeywords: true },
          })
        ),
      ]);
      data = applyMatchSuggestions(
        data as Array<typeof data[number] & { description: string | null; amount: number }>,
        units,
        suppliers,
      ) as typeof data;
    } catch {
      // soft fail
    }
  }

  const pagination = isPaginated
    ? buildPaginationMeta(pp, await countWhere(postgres, schema.bankTransaction, where))
    : undefined;

  if (withMeta !== "1" && withMeta !== "true") {
    return ctx.json(pagination ? { data, pagination } : { data });
  }

  // availableYears: anos com bank_transactions no condomínio (lista do dropdown, sem outros filtros).
  const availableYears = await listAvailableYears(
    postgres,
    schema.bankTransaction,
    schema.bankTransaction.transactionDate,
    listWhere(schema.bankTransaction, condominiumId),
  );

  return ctx.json({
    data,
    meta: { availableYears },
    ...(pagination ? { pagination } : {}),
  });
};
