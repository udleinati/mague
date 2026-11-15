// PATCH /v1/admin/condominiums/:cid/charges/:chargeId/budget
//
// Etiqueta a despesa com o orçamento que a Ata aprovou.
// Endpoint separado do PATCH geral de propósito: `updateCharge` só aceita
// charges `open`/`overdue` sem liquidação, e etiquetar despesas JÁ PAGAS é o
// caso normal - o relatório por Ata olha para trás. Sem impacto no ledger:
// budget_id é metadado de imputação, não mexe em valor nem estado.

import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { STATUS_CODE } from "@std/http";
import { z } from "zod";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { formatChargeForResponse } from "./_projection.ts";

const setBudgetSchema = z.object({
  budgetId: z.string().min(1).nullable(),
});

export const setChargeBudget = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const chargeId = requireParam(ctx, "chargeId");
  const body = await dtoValidator(setBudgetSchema, await ctx.req.json());

  const existing = await postgres.query((db) =>
    db.query.charge.findFirst({
      where: (e, ops) => ops.and(ops.eq(e.id, chargeId), ops.eq(e.condominiumId, condominiumId)),
      columns: { id: true, kind: true },
    })
  );
  const current = findEntityOrFail(existing, "Charge");

  if (current.kind !== "payable") {
    throw new AppError({
      message: "Só despesas se etiquetam com um orçamento - as quotas já apontam ao seu.",
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "CHARGE_BUDGET_KIND",
    });
  }

  // Tenant gate da FK: sem isto um manager de A etiquetava com orçamento de B.
  if (body.budgetId) {
    const budget = await postgres.query((db) =>
      db.select({ id: schema.budget.id }).from(schema.budget)
        .where(byIdInCondo(schema.budget, body.budgetId!, condominiumId))
    );
    if (budget.length === 0) {
      throw new AppError({
        message: "Orçamento não encontrado",
        statusCode: STATUS_CODE.NotFound,
        code: "NOT_FOUND",
      });
    }
  }

  const actor = requireActor(ctx);
  const [updated] = await postgres.query((db) =>
    db.update(schema.charge)
      .set({ budgetId: body.budgetId, updatedAt: new Date(), updatedBy: actor })
      .where(and(
        eq(schema.charge.id, chargeId),
        eq(schema.charge.condominiumId, condominiumId),
      ))
      .returning()
  );

  return ctx.json({ data: formatChargeForResponse(updated) });
};
