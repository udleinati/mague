import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { assertOwnership } from "$api/libs/shared/assert_ownership.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { assemblyCreateSchema } from "$api/libs/model/assembly.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatAssemblyForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const createAssembly = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const body = await dtoValidator(assemblyCreateSchema, await ctx.req.json());
  await assertOwnership(postgres, body, condominiumId, { document: "minutesDocumentId" });

  const insert = await postgres.query((db) =>
    db.insert(schema.assembly).values({
      condominiumId,
      type: body.type,
      scheduledAt: new Date(body.scheduledAt),
      secondConvocationAt: body.secondConvocationAt ? new Date(body.secondConvocationAt) : null,
      location: body.location ?? null,
      convocationSentAt: body.convocationSentAt ? new Date(body.convocationSentAt) : null,
      minutesNumber: body.minutesNumber ?? null,
      minutesDocumentId: body.minutesDocumentId ?? null,
      notes: body.notes ?? null,
      createdBy: actor,
      updatedBy: actor,
    }).returning()
  );

  const created = insert[0];
  if (!created) {
    throw new AppError({
      message: "Erro ao criar assembleia",
      statusCode: STATUS_CODE.InternalServerError,
      code: "DB_ERROR",
    });
  }

  return ctx.json({ data: formatAssemblyForResponse(created) }, STATUS_CODE.Created);
};
