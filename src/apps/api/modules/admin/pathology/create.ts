// POST /v1/admin/c/:cid/pathologies

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { pathologyCreateSchema } from "$api/libs/model/pathology.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { formatPathologyForResponse } from "./_projection.ts";
import { syncPathologyUnits } from "./_helpers.ts";

export const createPathology = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const body = await dtoValidator(pathologyCreateSchema, await ctx.req.json());

  // Garantir que os unitIds pertencem ao condo (anti-IDOR).
  if (body.unitIds && body.unitIds.length > 0) {
    const ownUnits = await postgres.query((db) =>
      db.query.unit.findMany({
        where: (u, ops) =>
          ops.and(
            ops.inArray(u.id, body.unitIds!),
            ops.eq(u.condominiumId, condominiumId),
            ops.isNull(u.deletedAt),
          ),
        columns: { id: true },
      })
    );
    if (ownUnits.length !== body.unitIds.length) {
      throw new AppError({
        message: "Uma ou mais frações não pertencem a este condomínio.",
        statusCode: STATUS_CODE.UnprocessableEntity,
        code: "INVALID_UNITS",
      });
    }
  }

  const insert = await postgres.query((db) =>
    db.insert(schema.pathology).values({
      condominiumId,
      title: body.title,
      description: body.description ?? null,
      category: body.category,
      status: body.status,
      affectsCommonArea: body.affectsCommonArea,
      resolutionNotes: body.resolutionNotes ?? null,
      dismissedReason: body.dismissedReason ?? null,
      detectedAt: body.detectedAt ?? new Date().toISOString().slice(0, 10),
      resolvedAt: body.resolvedAt ?? null,
      dismissedAt: body.dismissedAt ?? null,
      createdBy: actor,
      updatedBy: actor,
    }).returning()
  );
  const created = insert[0];

  if (body.unitIds && body.unitIds.length > 0) {
    await syncPathologyUnits(postgres, created.id, body.unitIds);
  }

  return ctx.json(
    { data: formatPathologyForResponse(created) },
    STATUS_CODE.Created,
  );
};
