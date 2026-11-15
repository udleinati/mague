import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { documentCreateSchema } from "$api/libs/model/document.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { formatDocumentForResponse } from "./_projection.ts";

export const createDocument = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);
  const body = await dtoValidator(documentCreateSchema, await ctx.req.json());

  const insert = await postgres.query((db) =>
    db.insert(schema.document).values({
      condominiumId,
      title: body.title,
      description: body.description ?? null,
      category: body.category,
      isPublic: body.isPublic,
      // publishedAt nullable: docs sem data oficial (regulamento,
      // planta, manual) ficam null.
      publishedAt: body.publishedAt ?? null,
      createdBy: actor,
      updatedBy: actor,
    }).returning()
  );

  const created = insert[0];
  if (!created) {
    throw new AppError({
      message: "Erro ao criar documento",
      statusCode: STATUS_CODE.InternalServerError,
      code: "DB_ERROR",
    });
  }

  return ctx.json({ data: formatDocumentForResponse(created) }, STATUS_CODE.Created);
};
