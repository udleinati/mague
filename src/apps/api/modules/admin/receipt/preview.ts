// POST /v1/admin/condominiums/:cid/receipts/preview - Body igual ao emit. Devolve o HTML do
// recibo tal como sairia (mesmo template do PDF), sem número e sem gravar nada.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { buildSnapshots, findPendingTuple } from "./emit_orchestrator.ts";
import { parseRecipientChoice } from "./recipients.ts";
import { renderReceiptHtml } from "./pdf.ts";

export const previewReceiptHandler = async (ctx: Context, postgres: Postgres) => {
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

  const pending = await findPendingTuple(postgres, { condominiumId, bankTransactionId, unitId });
  const snapshots = await buildSnapshots(postgres, {
    condominiumId,
    bankTransactionId,
    unitId,
    paymentDate: String(pending.payment_date),
    recipient,
  });
  const html = await renderReceiptHtml(
    {
      number: null,
      issuedAt: new Date(),
      voidedAt: null,
      voidedReason: null,
      amountCents: snapshots.lines.reduce((sum, l) => sum + l.amount, 0),
    },
    snapshots,
    "",
    { preview: true },
  );
  return ctx.json({ data: { html } });
};
