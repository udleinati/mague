import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { supplierUpdateSchema } from "$api/libs/model/supplier.ts";
import { assertOwnership } from "$api/libs/shared/assert_ownership.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatSupplierForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const updateSupplier = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const supplierId = requireParam(ctx, "supplierId");

  const body = await dtoValidator(supplierUpdateSchema, await ctx.req.json());
  await assertOwnership(postgres, body, condominiumId, { account: "accountId" });

  const existing = await postgres.query((db) =>
    db.query.supplier.findFirst({
      where: byIdInCondo(schema.supplier, supplierId, condominiumId),
    })
  );
  const data = findEntityOrFail(existing, "Fornecedor");

  // Limpa + dedup das keywords (trim, remove vazios).
  const cleanedMatchKeywords = body.matchKeywords !== undefined
    ? [...new Set(body.matchKeywords.map((k) => k.trim()).filter((k) => k.length > 0))]
    : undefined;

  const update = await postgres.query((db) =>
    db.update(schema.supplier)
      .set({
        name: body.name ?? data.name,
        nif: body.nif !== undefined ? body.nif : data.nif,
        contactName: body.contactName !== undefined ? body.contactName : data.contactName,
        contactEmail: body.contactEmail !== undefined ? body.contactEmail : data.contactEmail,
        contactPhone: body.contactPhone !== undefined ? body.contactPhone : data.contactPhone,
        accountId: body.accountId !== undefined ? body.accountId : data.accountId,
        notes: body.notes !== undefined ? body.notes : data.notes,
        isActive: body.isActive !== undefined ? body.isActive : data.isActive,
        matchKeywords: cleanedMatchKeywords !== undefined
          ? cleanedMatchKeywords
          : data.matchKeywords,
        updatedAt: new Date(),
        updatedBy: requireActor(ctx) ?? data.updatedBy,
      })
      .where(byIdInCondo(schema.supplier, supplierId, condominiumId))
      .returning()
  );

  const updated = update[0];
  if (!updated) {
    throw new AppError({
      message: "Fornecedor não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  return ctx.json({ data: formatSupplierForResponse(updated) });
};
