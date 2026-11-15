// POST /settlements - criar conciliação manual ou offset.
//
// Cascade explícita em TS (createSettlement orchestrator).
// Trigger fn_settlement_ai emite o ledger; TS faz validação + UPDATE charge + UPDATE bank_tx.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { settlementCreateSchema } from "$api/libs/model/bank_transaction.ts";
import { formatSettlementForResponse } from "./_projection.ts";
import { createSettlement as createSettlementOp } from "./operation.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const createSettlement = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const body = await dtoValidator(settlementCreateSchema, await ctx.req.json());

  const result = await createSettlementOp({
    settlementType: body.settlementType,
    condominiumId,
    unitId: null,
    amount: body.amount,
    settlementDate: body.settlementDate,
    notes: body.notes ?? "",
    actor,
    bankTransactionId: body.bankTransactionId ?? null,
    debitChargeId: body.debitChargeId ?? null,
    creditChargeId: body.creditChargeId ?? null,
  }, postgres);

  // Re-fetch settlement row para serializar (operation devolve só o id + effects).
  const settlement = await postgres.query((db) =>
    db.query.settlement.findFirst({
      where: (s, ops) => ops.eq(s.id, result.settlementId),
    })
  );

  return ctx.json({ data: formatSettlementForResponse(settlement!) }, STATUS_CODE.Created);
};
