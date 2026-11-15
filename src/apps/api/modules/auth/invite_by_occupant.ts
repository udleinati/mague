// POST /v1/admin/condominiums/:cid/occupants/:occId/invite - convida occupant
// para o portal sem contexto de fração. Pré-condição: occupant.email (400 se vazio).

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import {
  INVITE_RESEND_COOLDOWN_DAYS,
  isInInviteResendCooldown,
} from "$shared/auth/invite_eligibility.ts";
import { loadLastInvitedAt } from "./invite_history.ts";
import { inviteOccupant } from "./invite_flow.ts";

export const inviteByOccupant = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const occupantId = ctx.req.param("occupantId");
  if (!occupantId) {
    throw new AppError({
      message: "occupantId é obrigatório",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  // Validação multi-tenant: occupant tem de pertencer ao condo do path.
  const occupant = await postgres.query((db) =>
    db.query.occupant.findFirst({
      where: (o, ops) =>
        ops.and(
          ops.eq(o.id, occupantId),
          ops.eq(o.condominiumId, condominiumId),
          ops.isNull(o.deletedAt),
        ),
    })
  );
  if (!occupant) {
    throw new AppError({
      message: "Ocupante não encontrado neste condomínio",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  if (!occupant.email || !occupant.email.trim()) {
    throw new AppError({
      message: "Ocupante não tem email - adiciona um antes de convidar.",
      statusCode: STATUS_CODE.BadRequest,
      code: "MISSING_EMAIL",
    });
  }

  // Guard cooldown (ADR 0032). `loadLastInvitedAt` é a MESMA fonte que a UI
  // usa, para o botão desactivado e este 422 nunca divergirem. Sem userId = sem cooldown.
  if (occupant.userId) {
    const lastInvitedAt = (await loadLastInvitedAt(postgres, [occupant.userId]))
      .get(occupant.userId) ?? null;
    if (isInInviteResendCooldown(lastInvitedAt, new Date())) {
      throw new AppError({
        message:
          `Convite já enviado nos últimos ${INVITE_RESEND_COOLDOWN_DAYS} dias. Aguarda antes de reenviar.`,
        statusCode: STATUS_CODE.UnprocessableEntity,
        code: "COOLDOWN_ACTIVE",
      });
    }
  }

  const cond = await postgres.query((db) =>
    db.query.condominium.findFirst({ where: (c, ops) => ops.eq(c.id, condominiumId) })
  );
  const { safePanelBaseUrl } = await import("$api/libs/shared/panel_base_url.ts");
  const baseUrl = safePanelBaseUrl(ctx);
  const actor = requireActor(ctx);

  let result;
  try {
    result = await inviteOccupant({
      postgres,
      occupant,
      panelBaseUrl: baseUrl,
      condominium: {
        id: condominiumId,
        name: cond?.name ?? "Condomínio",
        designationType: cond?.designationType ?? null,
      },
      actor: actor ?? null,
      mode: "strict",
      managedCondominiumIds: ctx.get("role") === "super"
        ? null
        : ctx.get("managedCondominiumIds") ?? [],
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError({
      message: `Falha ao enviar convite: ${(e as Error).message}`,
      statusCode: STATUS_CODE.InternalServerError,
      code: "INVITE_FAILED",
    });
  }

  return ctx.json({
    data: {
      userId: result.userId,
      sentTo: occupant.email,
      expiresAt: result.expiresAt?.toISOString() ?? null,
    },
  }, STATUS_CODE.Created);
};
