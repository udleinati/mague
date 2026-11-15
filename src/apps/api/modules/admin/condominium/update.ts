import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { adminCondominiumUpdateSchema } from "$api/libs/model/admin_condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatCondominiumForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const updateMe = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const body = await dtoValidator(adminCondominiumUpdateSchema, await ctx.req.json());

  const existing = await postgres.query((db) =>
    db.query.condominium.findFirst({
      where: (entity, ops) =>
        ops.and(
          ops.eq(entity.id, condominiumId),
          ops.isNull(entity.deletedAt),
        ),
    })
  );
  const existingData = findEntityOrFail(existing, "Condomínio");

  const update = await postgres.transaction((tx) =>
    tx.update(schema.condominium)
      .set({
        name: body.name ?? existingData.name,
        designationType: body.designationType ?? existingData.designationType,
        fiscalNumber: body.fiscalNumber !== undefined
          ? body.fiscalNumber
          : existingData.fiscalNumber,
        email: body.email !== undefined ? body.email : existingData.email,
        bccEmail: body.bccEmail !== undefined ? body.bccEmail : existingData.bccEmail,
        replyToEmail: body.replyToEmail !== undefined
          ? body.replyToEmail
          : existingData.replyToEmail,
        address: body.address !== undefined ? body.address : existingData.address,
        city: body.city !== undefined ? body.city : existingData.city,
        postalCode: body.postalCode !== undefined ? body.postalCode : existingData.postalCode,
        quotaDayOfMonth: body.quotaDayOfMonth ?? existingData.quotaDayOfMonth,
        billingReminderNote: body.billingReminderNote !== undefined
          ? body.billingReminderNote
          : existingData.billingReminderNote,
        insuranceReminderNote: body.insuranceReminderNote !== undefined
          ? body.insuranceReminderNote
          : existingData.insuranceReminderNote,
        reconciledThroughDate: body.reconciledThroughDate !== undefined
          ? body.reconciledThroughDate
          : existingData.reconciledThroughDate,
        updatedAt: new Date(),
        updatedBy: actor,
      })
      .where(and(
        eq(schema.condominium.id, condominiumId),
        isNull(schema.condominium.deletedAt),
      ))
      .returning()
  );

  const updated = update[0];
  if (!updated) {
    throw new AppError({
      message: "Condomínio não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  return ctx.json({ data: formatCondominiumForResponse(updated) }, STATUS_CODE.OK);
};
