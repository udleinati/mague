// POST /v1/admin/condominiums/:cid/receipts - Body: { bankTransactionId, unitId, recipient? }.
// Emite 1 recibo com as conciliações da tupla (bank_tx, unit) ainda sem recibo. Wrapper sobre
// `emitReceipt`. `recipient` =
// { occupantId } ou { name, nif, email? } (ver recipients.ts); omitido = owners + residents.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { emitReceipt } from "./emit_orchestrator.ts";
import { parseRecipientChoice } from "./recipients.ts";

export const emitReceiptHandler = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const body = await ctx.req.json().catch(() => ({}));
  const bankTransactionId = String(body?.bankTransactionId ?? "").trim();
  const unitId = String(body?.unitId ?? "").trim();

  if (!bankTransactionId || !unitId) {
    throw new AppError({
      message: "bankTransactionId e unitId são obrigatórios",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const recipient = parseRecipientChoice(body?.recipient);
  const actor = requireActor(ctx);

  // Origin do panel para links nos emails; fallback para env.
  const { safePanelBaseUrl } = await import("$api/libs/shared/panel_base_url.ts");
  const panelBaseUrl = safePanelBaseUrl(ctx);

  try {
    const result = await emitReceipt(postgres, {
      condominiumId,
      bankTransactionId,
      unitId,
      actor: {
        id: actor.user_id ?? "",
        name: actor.email ?? (actor.user_id ?? ""),
        email: actor.email,
        // role não vem em ActorIdentity; deixar undefined
      },
      panelBaseUrl,
      recipient,
    });
    return ctx.json({ data: result }, STATUS_CODE.Created);
  } catch (e) {
    throw new AppError({
      message: (e as Error).message,
      statusCode: STATUS_CODE.BadRequest,
      code: "EMIT_FAILED",
    });
  }
};
