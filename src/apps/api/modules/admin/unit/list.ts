import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { listWhere } from "$api/libs/shared/list_query.ts";
import { formatUnitForResponse, UNIT_PROJECTION } from "./_projection.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { eq } from "drizzle-orm";
import { unitNaturalOrder } from "$api/libs/postgres/order_by.ts";

export const listMeUnits = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  // Em paralelo: frações (+ ocupantes), balances (view v_unit_balance) e
  // planos de pagamento ativos (ADR 0039 - badge na listagem).
  const [units, balances, activePlans] = await Promise.all([
    postgres.query((db) =>
      db.query.unit.findMany({
        where: listWhere(schema.unit, condominiumId),
        ...UNIT_PROJECTION,
        // Ordem natural: A, B, …, Z, AA, AB, … (length asc + alfabético).
        orderBy: unitNaturalOrder(schema.unit.designation),
      })
    ),
    postgres.query((db) =>
      db.select().from(schema.unitBalance).where(
        eq(schema.unitBalance.condominiumId, condominiumId),
      )
    ),
    postgres.query((db) =>
      db.query.paymentPlan.findMany({
        where: (p, ops) =>
          ops.and(
            ops.eq(p.condominiumId, condominiumId),
            ops.eq(p.status, "active"),
            ops.isNull(p.deletedAt),
          ),
        columns: { unitId: true },
      })
    ),
  ]);

  const activePlanUnitIds = new Set(activePlans.map((p) => p.unitId));

  // Mapa por unitId para zip O(1).
  const balanceByUnit = new Map(
    balances.map((b) => [b.unitId, {
      openDebtCents: b.openDebtCents,
      openCreditCents: b.openCreditCents,
      overdueDebtCents: b.overdueDebtCents,
      netCents: b.netCents,
    }]),
  );

  const data = units.map((unit) =>
    formatUnitForResponse(unit, {
      balance: balanceByUnit.get(unit.id),
      hasActivePlan: activePlanUnitIds.has(unit.id),
    })
  );

  return ctx.json({ data });
};
