import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { condominiumUpdateSchema } from "$api/libs/model/condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatCondominiumForResponse } from "$api/modules/admin/condominium/_projection.ts";

export const updateCondominium = async (ctx: Context, postgres: Postgres) => {
  const id = requireParam(ctx, "id");

  const body = await dtoValidator(condominiumUpdateSchema, await ctx.req.json());

  const existingData = await postgres.query((db) =>
    db.query.condominium.findFirst({
      where: (entity, ops) =>
        ops.and(
          ops.eq(entity.id, id),
          ops.isNull(entity.deletedAt),
        ),
    })
  );
  if (!existingData) {
    throw new AppError({
      message: "Condomínio não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  const update = await postgres.transaction((tx) =>
    tx.update(schema.condominium)
      .set({
        name: body.name ?? existingData.name,
        designationType: body.designationType ?? existingData.designationType,
        // Nullable: `!== undefined` permite enviar null para limpar o campo.
        fiscalNumber: body.fiscalNumber !== undefined
          ? body.fiscalNumber
          : existingData.fiscalNumber,
        email: body.email !== undefined ? (body.email || null) : existingData.email,
        bccEmail: body.bccEmail !== undefined ? body.bccEmail : existingData.bccEmail,
        replyToEmail: body.replyToEmail !== undefined
          ? body.replyToEmail
          : existingData.replyToEmail,
        address: body.address !== undefined ? body.address : existingData.address,
        city: body.city !== undefined ? body.city : existingData.city,
        postalCode: body.postalCode !== undefined ? body.postalCode : existingData.postalCode,
        quotaDayOfMonth: body.quotaDayOfMonth ?? existingData.quotaDayOfMonth,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.condominium.id, id), isNull(schema.condominium.deletedAt)))
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
