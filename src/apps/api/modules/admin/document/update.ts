import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { documentUpdateSchema } from "$api/libs/model/document.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { formatDocumentForResponse } from "./_projection.ts";

export const updateDocument = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const documentId = requireParam(ctx, "documentId");
  const body = await dtoValidator(documentUpdateSchema, await ctx.req.json());

  const existing = await postgres.query((db) =>
    db.query.document.findFirst({
      where: byIdInCondo(schema.document, documentId, condominiumId),
    })
  );
  const existingData = findEntityOrFail(existing, "Documento");

  const update = await postgres.query((db) =>
    db.update(schema.document)
      .set({
        title: body.title ?? existingData.title,
        description: body.description !== undefined ? body.description : existingData.description,
        category: body.category ?? existingData.category,
        isPublic: body.isPublic !== undefined ? body.isPublic : existingData.isPublic,
        // publishedAt 3 estados: undefined = preserva, null = limpa, string = atualiza.
        publishedAt: body.publishedAt !== undefined ? body.publishedAt : existingData.publishedAt,
        updatedAt: new Date(),
        updatedBy: requireActor(ctx) ?? existingData.updatedBy,
      })
      .where(byIdInCondo(schema.document, documentId, condominiumId))
      .returning()
  );

  const updated = update[0];
  if (!updated) {
    throw new AppError({
      message: "Documento não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  return ctx.json({ data: formatDocumentForResponse(updated) }, STATUS_CODE.OK);
};
