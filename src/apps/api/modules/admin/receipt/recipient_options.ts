// GET /v1/admin/condominiums/:cid/receipts/recipient-options?bankTransactionId=&unitId=
// Opções do "Emitir para…": ocupantes ligados à fração na data do pagamento (qualquer relação).

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { findPendingTuple } from "./emit_orchestrator.ts";
import { listRecipientCandidates } from "./recipients.ts";

export const listRecipientOptions = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const bankTransactionId = (ctx.req.query("bankTransactionId") ?? "").trim();
  const unitId = (ctx.req.query("unitId") ?? "").trim();
  if (!bankTransactionId || !unitId) {
    throw new AppError({
      message: "bankTransactionId e unitId são obrigatórios",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const pending = await findPendingTuple(postgres, { condominiumId, bankTransactionId, unitId });
  const paymentDate = String(pending.payment_date);
  const candidates = await listRecipientCandidates(postgres, {
    condominiumId,
    unitId,
    paymentDate,
  });

  return ctx.json({
    data: {
      paymentDate,
      amountCents: Number(pending.recipient_amount),
      candidates: candidates.map((c) => ({
        occupantId: c.occupantId,
        name: c.name,
        nif: c.nif,
        email: c.email,
        relationshipType: c.relationshipType,
      })),
    },
  });
};
