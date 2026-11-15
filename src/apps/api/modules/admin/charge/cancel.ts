// POST /charges/:chargeId/cancel - transição de status para 'cancelled'.
// Triggers fn_charge_bu/au (004_trg_financial.sql) zeram os montantes e emitem
// o ledger inverso. Só cancela 'open'/'overdue' com settled_amount=0; guards
// repetidos no WHERE para que um estado mudado mid-flight afete 0 linhas → 409.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, inArray } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatChargeForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

const CANCELLABLE_STATUSES = new Set(["open", "overdue"]);

export const cancelCharge = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const chargeId = requireParam(ctx, "chargeId");

  const existing = await postgres.query((db) =>
    db.query.charge.findFirst({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, chargeId),
          ops.eq(e.condominiumId, condominiumId),
        ),
    })
  );
  const current = findEntityOrFail(existing, "Charge");

  if (current.status === "cancelled") {
    throw new AppError({
      message: "Charge já está cancelada.",
      statusCode: STATUS_CODE.Conflict,
      code: "CHARGE_ALREADY_CANCELLED",
    });
  }

  // Guard: só open/overdue sem settlements. O trigger BEFORE bloquearia
  // settlements ativos de qualquer forma, mas damos um 409 limpo e acionável.
  if (
    !CANCELLABLE_STATUSES.has(String(current.status)) ||
    Number(current.settledAmount ?? 0) > 0
  ) {
    throw new AppError({
      message:
        `Charge em estado '${current.status}' não pode ser cancelada diretamente. Reverte os settlements primeiro.`,
      statusCode: STATUS_CODE.Conflict,
      code: "CHARGE_NOT_CANCELLABLE",
    });
  }

  const actor = requireActor(ctx);

  // UPDATE atómico com guards repetidos no WHERE. Os triggers fn_charge_bu /
  // fn_charge_au tratam de zerar os montantes e emitir o ledger inverso.
  const updatedRows = await postgres.query((db) =>
    db.update(schema.charge)
      .set({ status: "cancelled", updatedAt: new Date(), updatedBy: actor })
      .where(and(
        eq(schema.charge.id, chargeId),
        eq(schema.charge.condominiumId, condominiumId),
        inArray(schema.charge.status, ["open", "overdue"]),
        eq(schema.charge.settledAmount, 0),
      ))
      .returning()
  );

  const updated = updatedRows[0];
  if (!updated) {
    // 0 linhas → ou a charge desapareceu (404), ou o estado mudou mid-flight
    // (race condition: 409). Distinguimos com um SELECT de follow-up.
    const stillExists = await postgres.query((db) =>
      db.query.charge.findFirst({
        where: (e, ops) =>
          ops.and(
            ops.eq(e.id, chargeId),
            ops.eq(e.condominiumId, condominiumId),
          ),
        columns: { id: true },
      })
    );
    if (stillExists) {
      throw new AppError({
        message:
          "Estado da charge mudou durante o cancelamento (settlement concorrente?). Recarrega e tenta de novo.",
        statusCode: STATUS_CODE.Conflict,
        code: "CHARGE_STATE_CHANGED",
      });
    }
    throw new AppError({
      message: "Charge não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  return ctx.json({ data: formatChargeForResponse(updated) }, STATUS_CODE.OK);
};
