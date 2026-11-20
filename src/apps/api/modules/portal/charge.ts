// /v1/portal/condominiums/:cid/units/:unitId/charges - GET read-only das charges
// da fração. O `:unitId` vem SEMPRE do path (query string ignorada); o occupant
// não foge para outra fração.

import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { sql } from "drizzle-orm";
import { portalScope } from "$api/libs/portal/scope.ts";
import { inOwnerWindowSql, loadPortalOwnerWindow } from "$api/libs/portal/owner_window.ts";
import { parseLimit } from "$api/libs/shared/pagination.ts";
import { parseYear } from "$api/libs/shared/list_query.ts";
import {
  CHARGE_PROJECTION,
  formatChargeForResponse,
} from "$api/modules/admin/charge/_projection.ts";

const OPEN_ANY_STATUSES = ["open", "partial", "overdue"] as const;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

// CHARGE_PROJECTION + settlements onde a charge é o lado debitado (com bank tx):
// mostra ao condómino "como esta cobrança foi paga".
const PORTAL_CHARGE_WITH_PAYMENTS = {
  ...CHARGE_PROJECTION.with,
  debitSettlements: {
    columns: {
      id: true,
      amount: true,
      settlementDate: true,
      settlementType: true,
      status: true,
    },
    with: {
      bankTransaction: {
        columns: {
          id: true,
          transactionDate: true,
          description: true,
          amount: true,
        },
      },
    },
  },
} as const;

interface SettlementForPortal {
  id: string;
  amount: number;
  settlementDate: string | null;
  settlementType: string;
  status: string;
  bankTransaction: {
    id: string;
    transactionDate: string | Date;
    description: string | null;
    amount: number;
  } | null;
}

// Shape mínima para a UI: data efetiva (prefere a do bank_tx), valor, descrição.
// Settlements `reversed` são filtrados (não fazem parte da história final de pagamento).
function shapeSettlementForPortal(s: SettlementForPortal) {
  if (s.status === "reversed") return null;
  const date = s.bankTransaction?.transactionDate
    ? String(s.bankTransaction.transactionDate).slice(0, 10)
    : s.settlementDate;
  return {
    id: s.id,
    date,
    amount: s.amount,
    settlementType: s.settlementType,
    bankTransaction: s.bankTransaction
      ? {
        id: s.bankTransaction.id,
        description: s.bankTransaction.description,
      }
      : null,
  };
}

export const portalListCharges = async (ctx: Context, postgres: Postgres) => {
  const { cid: condominiumId, unitId } = portalScope(ctx);

  // Filtros opcionais (kind, status, year, limit); `unitId` da query ignorado (vem do path).
  const { kind, status, year: yearRaw, limit: limitRaw } = ctx.req.query();
  const year = parseYear(yearRaw);
  const limit = parseLimit(limitRaw, { default: DEFAULT_LIMIT, max: MAX_LIMIT });
  const ownerWindow = await loadPortalOwnerWindow(ctx, postgres, unitId);

  const result = await postgres.query((db) =>
    db.query.charge.findMany({
      where: (e, ops) => {
        const filters = [
          ops.eq(e.condominiumId, condominiumId),
          ops.eq(e.unitId, unitId), // ← FIXO no path. O occupant não foge.
        ];
        if (kind) filters.push(ops.eq(e.kind, kind));
        if (status === "open_any") {
          filters.push(ops.inArray(e.status, [...OPEN_ANY_STATUSES]));
        } else if (status) {
          filters.push(ops.eq(e.status, status));
        }
        if (year !== null) {
          filters.push(ops.gte(e.competencePeriod, `${year}-01-01`));
          filters.push(ops.lte(e.competencePeriod, `${year}-12-31`));
        }
        const inWindow = inOwnerWindowSql(
          sql`COALESCE(${e.competencePeriod}, ${e.issueDate})`,
          ownerWindow,
        );
        if (inWindow) filters.push(inWindow);
        return ops.and(...filters);
      },
      orderBy: (e, ops) => [ops.desc(e.competencePeriod), ops.desc(e.createdAt)],
      limit,
      columns: CHARGE_PROJECTION.columns,
      with: PORTAL_CHARGE_WITH_PAYMENTS,
    })
  );

  const data = result.map((row) => {
    const settlements = (
      (row as unknown as { debitSettlements?: SettlementForPortal[] }).debitSettlements ?? []
    )
      .map(shapeSettlementForPortal)
      .filter((s): s is NonNullable<ReturnType<typeof shapeSettlementForPortal>> => s !== null)
      // Ordena por data (settlements sem data ficam no fim).
      .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));
    // `note` e `cancellationReason` são internos do admin - removidos antes do portal.
    const { note: _note, cancellationReason: _reason, ...publicCharge } = formatChargeForResponse(
      row,
    );
    return { ...publicCharge, settlements };
  });
  return ctx.json({ data });
};
