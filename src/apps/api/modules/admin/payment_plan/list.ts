// GET /v1/admin/condominiums/:cid/units/:unitId/payment-plans
// Lista os planos da fração (active + histórico terminal). Ver ADR 0039.

import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { formatPaymentPlanForResponse } from "./_projection.ts";

export const listPaymentPlans = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const unitId = requireParam(ctx, "unitId");

  const rows = await postgres.query((db) =>
    db.query.paymentPlan.findMany({
      where: (p, ops) =>
        ops.and(
          ops.eq(p.unitId, unitId),
          ops.eq(p.condominiumId, condominiumId),
          ops.isNull(p.deletedAt),
        ),
      orderBy: (p, ops) => [ops.desc(p.createdAt)],
    })
  );

  return ctx.json({ data: rows.map(formatPaymentPlanForResponse) });
};
