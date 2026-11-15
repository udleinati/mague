import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { supplierCreateSchema } from "$api/libs/model/supplier.ts";
import { assertOwnership } from "$api/libs/shared/assert_ownership.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatSupplierForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const createSupplier = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const body = await dtoValidator(supplierCreateSchema, await ctx.req.json());
  await assertOwnership(postgres, body, condominiumId, { account: "accountId" });

  const cleanedMatchKeywords = body.matchKeywords !== undefined
    ? [...new Set(body.matchKeywords.map((k) => k.trim()).filter((k) => k.length > 0))]
    : [];

  const insert = await postgres.query((db) =>
    db.insert(schema.supplier).values({
      condominiumId,
      name: body.name,
      nif: body.nif ?? null,
      contactName: body.contactName ?? null,
      contactEmail: body.contactEmail ?? null,
      contactPhone: body.contactPhone ?? null,
      accountId: body.accountId ?? null,
      notes: body.notes ?? null,
      matchKeywords: cleanedMatchKeywords,
      createdBy: requireActor(ctx),
      updatedBy: requireActor(ctx),
    }).returning()
  );

  const created = insert[0];
  if (!created) {
    throw new AppError({
      message: "Erro ao criar fornecedor",
      statusCode: STATUS_CODE.InternalServerError,
      code: "DB_ERROR",
    });
  }

  return ctx.json({ data: formatSupplierForResponse(created) }, STATUS_CODE.Created);
};
