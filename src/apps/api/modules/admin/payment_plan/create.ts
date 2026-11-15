// POST /v1/admin/condominiums/:cid/units/:unitId/payment-plans
// Cria um plano de pagamento active para a fração. Ver ADR 0039.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { paymentPlanCreateSchema } from "$api/libs/model/payment_plan.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { formatPaymentPlanForResponse } from "./_projection.ts";

export const createPaymentPlan = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const unitId = requireParam(ctx, "unitId");
  const actor = requireActor(ctx);

  const body = await dtoValidator(paymentPlanCreateSchema, await ctx.req.json());

  // Anti-IDOR: a fração tem de pertencer a este condomínio.
  const unit = await postgres.query((db) =>
    db.query.unit.findFirst({
      where: (u, ops) =>
        ops.and(
          ops.eq(u.id, unitId),
          ops.eq(u.condominiumId, condominiumId),
          ops.isNull(u.deletedAt),
        ),
      columns: { id: true },
    })
  );
  if (!unit) {
    throw new AppError({
      message: "Fração não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  // 1 plano active por fração (o partial unique index também protege).
  const existingActive = await postgres.query((db) =>
    db.query.paymentPlan.findFirst({
      where: (p, ops) =>
        ops.and(
          ops.eq(p.unitId, unitId),
          ops.eq(p.status, "active"),
          ops.isNull(p.deletedAt),
        ),
      columns: { id: true },
    })
  );
  if (existingActive) {
    throw new AppError({
      message: "Esta fração já tem um plano de pagamento ativo.",
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "PAYMENT_PLAN_ALREADY_ACTIVE",
    });
  }

  const insert = await postgres.query((db) =>
    db.insert(schema.paymentPlan).values({
      condominiumId,
      unitId,
      status: "active",
      notes: body.notes ?? null,
      internalNotes: body.internalNotes ?? null,
      endDate: body.endDate ?? null,
      endedAt: null,
      createdBy: actor,
      updatedBy: actor,
    }).returning()
  );

  return ctx.json(
    { data: formatPaymentPlanForResponse(insert[0]) },
    STATUS_CODE.Created,
  );
};
