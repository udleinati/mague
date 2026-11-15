// PATCH /recurring_templates/:id - edita um template recorrente.
// Permite alterar valor, descrição, intervalo, categoria, fornecedor,
// ativar/desactivar (isActive), data final, próxima geração.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { recurringTemplateUpdateSchema } from "$api/libs/model/recurring_template.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatRecurringTemplateForResponse } from "./_projection.ts";
import { assertOwnership } from "$api/libs/shared/assert_ownership.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const updateRecurringTemplate = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const templateId = requireParam(ctx, "templateId");

  const body = await dtoValidator(recurringTemplateUpdateSchema, await ctx.req.json());

  const existing = await postgres.query((db) =>
    db.query.recurringTemplate.findFirst({
      where: byIdInCondo(schema.recurringTemplate, templateId, condominiumId),
    })
  );
  const current = findEntityOrFail(existing, "Template recorrente");

  // Scope check em FKs quando alteradas (prevenir cross-tenant).
  await assertOwnership(postgres, body, condominiumId, {
    supplier: "supplierId",
    account: "accountId",
  });

  const result = await postgres.query((db) =>
    db.update(schema.recurringTemplate)
      .set({
        description: body.description ?? current.description,
        amount: body.amount ?? current.amount,
        accountId: body.accountId !== undefined ? body.accountId : current.accountId,
        supplierId: body.supplierId !== undefined ? body.supplierId : current.supplierId,
        contractId: body.contractId !== undefined ? body.contractId : current.contractId,
        intervalType: body.intervalType ?? current.intervalType,
        paymentMethod: body.paymentMethod ?? current.paymentMethod,
        dayOfMonth: body.dayOfMonth !== undefined ? body.dayOfMonth : current.dayOfMonth,
        endDate: body.endDate !== undefined ? body.endDate : current.endDate,
        nextRunDate: body.nextRunDate ?? current.nextRunDate,
        isActive: body.isActive !== undefined ? body.isActive : current.isActive,
        notes: body.notes !== undefined ? body.notes : current.notes,
        updatedAt: new Date(),
        updatedBy: actor,
      })
      .where(byIdInCondo(schema.recurringTemplate, templateId, condominiumId))
      .returning()
  );

  const updated = result[0];
  if (!updated) {
    throw new AppError({
      message: "Template recorrente não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  return ctx.json(
    { data: formatRecurringTemplateForResponse(updated) },
    STATUS_CODE.OK,
  );
};
