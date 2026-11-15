// PATCH /charges/:chargeId - edita uma charge (uso real: fatura recorrente com
// valor diferente do previsto). Guards: só 'open'/'overdue' com settled=0;
// amount edit só em nature=debit/kind=payable não-refaturação (quotas/refact.
// exigem nota de crédito). Os guards são REPETIDOS no WHERE do UPDATE (defesa
// contra race: estado mudado mid-flight afeta 0 linhas → 409). Ledger delta vem
// do trigger trg_charge_amount_adjust_ledger.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { chargeUpdateSchema } from "$api/libs/model/charge.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatChargeForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

const EDITABLE_STATUSES = new Set(["open", "overdue"]);
const AMOUNT_LOCKED_TYPES = new Set(["quota", "extraordinary_quota", "refacturation"]);

export const updateCharge = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const chargeId = requireParam(ctx, "chargeId");

  const body = await dtoValidator(chargeUpdateSchema, await ctx.req.json());

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

  // Guard 1: status tem de ser editável.
  if (!EDITABLE_STATUSES.has(String(current.status))) {
    throw new AppError({
      message:
        `Charge em estado '${current.status}' não pode ser editada. Reverte os settlements primeiro.`,
      statusCode: STATUS_CODE.Conflict,
      code: "CHARGE_LOCKED",
    });
  }

  // Guard 2: sem settlements (reforço contra status).
  if (Number(current.settledAmount ?? 0) > 0) {
    throw new AppError({
      message: "Charge tem valor já liquidado. Reverte os settlements primeiro.",
      statusCode: STATUS_CODE.Conflict,
      code: "CHARGE_LOCKED",
    });
  }

  // Guard 3: amount edit só em tipos compatíveis com ledger delta simples.
  const wantsAmountChange = body.amountCents !== undefined &&
    body.amountCents !== current.originalAmount;
  if (wantsAmountChange) {
    if (AMOUNT_LOCKED_TYPES.has(String(current.chargeType))) {
      throw new AppError({
        message:
          `Valor de charges do tipo '${current.chargeType}' não pode ser editado diretamente (ledger exige nota de crédito). Cancela e recria, ou usa credit_adjustment na fração.`,
        statusCode: STATUS_CODE.Conflict,
        code: "AMOUNT_EDIT_LOCKED",
      });
    }
    if (current.nature !== "debit" || current.kind !== "payable") {
      throw new AppError({
        message: "Valor só é editável em charges nature=debit, kind=payable (faturas a pagar).",
        statusCode: STATUS_CODE.Conflict,
        code: "AMOUNT_EDIT_LOCKED",
      });
    }
  }

  const actor = requireActor(ctx);
  const nextAmount = body.amountCents ?? current.originalAmount;

  // ─── UPDATE atómico com guards repetidos no WHERE ──────────────────────
  const updatedRows = await postgres.query((db) =>
    db.update(schema.charge)
      .set({
        description: body.description ?? current.description,
        issueDate: body.issueDate ?? current.issueDate,
        dueDate: body.dueDate !== undefined ? body.dueDate : current.dueDate,
        competencePeriod: body.competencePeriod !== undefined
          ? body.competencePeriod
          : current.competencePeriod,
        // original_amount dispara o trigger de ledger delta; expected_amount tem
        // de acompanhar (target do fn_settlement_ai, senão deixa resíduo); amount
        // (já conciliado) começa em 0 e ajusta-se via fn_settlement_ai.
        originalAmount: nextAmount,
        expectedAmount: nextAmount,
        openAmount: nextAmount,
        amount: 0,
        invoiceNumber: body.invoiceNumber !== undefined
          ? body.invoiceNumber
          : current.invoiceNumber,
        documentNumber: body.documentNumber !== undefined
          ? body.documentNumber
          : current.documentNumber,
        paymentMethod: body.paymentMethod ?? current.paymentMethod,
        note: body.note !== undefined ? body.note : current.note,
        updatedAt: new Date(),
        updatedBy: actor,
      })
      .where(and(
        eq(schema.charge.id, chargeId),
        eq(schema.charge.condominiumId, condominiumId),
        // Optimistic concurrency: estado tem de continuar editável.
        inArray(schema.charge.status, ["open", "overdue"]),
        eq(schema.charge.settledAmount, 0),
        // Se a operação muda o amount, type tem de continuar não-bloqueado.
        ...(wantsAmountChange
          ? [notInArray(schema.charge.chargeType, [...AMOUNT_LOCKED_TYPES])]
          : []),
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
          "Estado da charge mudou durante a edição (settlement concorrente?). Recarrega e tenta de novo.",
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
