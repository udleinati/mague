// PATCH /v1/admin/condominiums/:cid/units/:unitId/payment-plans/:planId
// Edita notas/data e/ou transita o estado (active -> terminal). Ver ADR 0039.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import {
  hasPaymentPlanNote,
  PAYMENT_PLAN_NOTE_REQUIRED,
  paymentPlanUpdateSchema,
} from "$api/libs/model/payment_plan.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { formatPaymentPlanForResponse } from "./_projection.ts";

export const updatePaymentPlan = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const planId = requireParam(ctx, "planId");
  const actor = requireActor(ctx);

  const body = await dtoValidator(paymentPlanUpdateSchema, await ctx.req.json());

  const existing = await postgres.query((db) =>
    db.query.paymentPlan.findFirst({
      where: byIdInCondo(schema.paymentPlan, planId, condominiumId),
    })
  );
  const current = findEntityOrFail(existing, "Plano de pagamento");

  // `null` apaga a nota; ausente mantém a gravada. O resultado tem de ficar com uma.
  const notes = body.notes !== undefined ? body.notes : current.notes;
  const internalNotes = body.internalNotes !== undefined
    ? body.internalNotes
    : current.internalNotes;
  if (!hasPaymentPlanNote({ notes, internalNotes })) {
    throw new AppError({
      message: PAYMENT_PLAN_NOTE_REQUIRED,
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  // Transições manuais (ADR 0039): active <-> terminal. ended_at acompanha:
  // entra em terminal -> agora; reabre para active -> NULL; muda de razão
  // entre terminais -> preserva o ended_at original.
  const nextStatus = body.status ?? current.status;
  const wasActive = current.status === "active";
  const isActive = nextStatus === "active";

  const nextEndedAt = isActive ? null : (wasActive ? new Date() : (current.endedAt ?? new Date()));

  // Reabrir um plano colide com o "1 active por fração" se já houver outro.
  if (isActive && !wasActive) {
    const otherActive = await postgres.query((db) =>
      db.query.paymentPlan.findFirst({
        where: (p, ops) =>
          ops.and(
            ops.eq(p.unitId, current.unitId),
            ops.eq(p.status, "active"),
            ops.isNull(p.deletedAt),
          ),
        columns: { id: true },
      })
    );
    if (otherActive) {
      throw new AppError({
        message: "Esta fração já tem outro plano de pagamento ativo.",
        statusCode: STATUS_CODE.UnprocessableEntity,
        code: "PAYMENT_PLAN_ALREADY_ACTIVE",
      });
    }
  }

  const updated = await postgres.query((db) =>
    db.update(schema.paymentPlan).set({
      notes,
      internalNotes,
      endDate: body.endDate !== undefined ? body.endDate : current.endDate,
      status: nextStatus,
      endedAt: nextEndedAt,
      updatedAt: new Date(),
      updatedBy: actor,
    }).where(byIdInCondo(schema.paymentPlan, planId, condominiumId)).returning()
  );

  return ctx.json({ data: formatPaymentPlanForResponse(updated[0]) });
};
