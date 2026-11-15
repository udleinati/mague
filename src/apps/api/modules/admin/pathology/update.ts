// PATCH /v1/admin/c/:cid/pathologies/:pathologyId

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { pathologyUpdateSchema } from "$api/libs/model/pathology.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { formatPathologyForResponse } from "./_projection.ts";
import { syncPathologyUnits } from "./_helpers.ts";

export const updatePathology = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const pathologyId = requireParam(ctx, "pathologyId");
  const actor = requireActor(ctx);

  const body = await dtoValidator(pathologyUpdateSchema, await ctx.req.json());

  const existing = await postgres.query((db) =>
    db.query.pathology.findFirst({
      where: byIdInCondo(schema.pathology, pathologyId, condominiumId),
    })
  );
  const current = findEntityOrFail(existing, "Patologia");

  // Validação cross-field "âmbito tem que existir" (parte comum OU ≥1 fração)
  // após aplicar os deltas que o caller passou. Usa current como fallback.
  const futureCommon = body.affectsCommonArea ?? current.affectsCommonArea;
  let futureUnitIds: string[] | undefined;
  if (body.unitIds !== undefined) {
    futureUnitIds = body.unitIds;
  } else {
    const rows = await postgres.query((db) =>
      db.query.pathologyUnit.findMany({
        where: (e, ops) => ops.eq(e.pathologyId, pathologyId),
        columns: { unitId: true },
      })
    );
    futureUnitIds = rows.map((r) => r.unitId);
  }
  if (!futureCommon && futureUnitIds.length === 0) {
    throw new AppError({
      message: "Pelo menos um âmbito é obrigatório: parte comum OU ≥1 fração.",
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "EMPTY_SCOPE",
    });
  }

  // Transitions livres (ADR 0024). Auto-preenche/limpa datas terminais quando o
  // caller não as passa: entra em terminal -> hoje; sai -> NULL (senão a data
  // ficava órfã). Caller explícito sempre vence.
  const nextStatus = body.status ?? current.status;
  const wasTerminalResolved = current.status === "resolved";
  const wasTerminalDismissed = current.status === "dismissed";
  const isTerminalResolved = nextStatus === "resolved";
  const isTerminalDismissed = nextStatus === "dismissed";

  const today = new Date().toISOString().slice(0, 10);
  const nextResolvedAt = body.resolvedAt !== undefined
    ? body.resolvedAt
    : (isTerminalResolved && !wasTerminalResolved
      ? today
      : (!isTerminalResolved && wasTerminalResolved ? null : current.resolvedAt));
  const nextDismissedAt = body.dismissedAt !== undefined
    ? body.dismissedAt
    : (isTerminalDismissed && !wasTerminalDismissed
      ? today
      : (!isTerminalDismissed && wasTerminalDismissed ? null : current.dismissedAt));

  // Validar unitIds vs condo se passados.
  if (body.unitIds !== undefined && body.unitIds.length > 0) {
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

  const updated = await postgres.query((db) =>
    db.update(schema.pathology).set({
      title: body.title ?? current.title,
      description: body.description !== undefined ? body.description : current.description,
      category: body.category ?? current.category,
      status: nextStatus,
      affectsCommonArea: body.affectsCommonArea ?? current.affectsCommonArea,
      resolutionNotes: body.resolutionNotes !== undefined
        ? body.resolutionNotes
        : current.resolutionNotes,
      dismissedReason: body.dismissedReason !== undefined
        ? body.dismissedReason
        : current.dismissedReason,
      detectedAt: body.detectedAt ?? current.detectedAt,
      resolvedAt: nextResolvedAt,
      dismissedAt: nextDismissedAt,
      updatedAt: new Date(),
      updatedBy: actor,
    }).where(byIdInCondo(schema.pathology, pathologyId, condominiumId)).returning()
  );
  const row = updated[0];
  if (!row) {
    throw new AppError({
      message: "Patologia não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  if (body.unitIds !== undefined) {
    await syncPathologyUnits(postgres, pathologyId, body.unitIds);
  }

  return ctx.json({ data: formatPathologyForResponse(row) });
};
