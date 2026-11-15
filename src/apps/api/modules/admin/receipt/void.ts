// POST /v1/admin/condominiums/:cid/receipts/:receiptId/void - Body: { reason } (obrigatório).
// Anula um recibo. Mantém número e `storage_key` (sobrepõe o ficheiro no S3 com a tarja
// "ANULADO"). Só manager/super (api_auth garante).

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { eq } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { formatReceiptForResponse } from "./_projection.ts";
import { renderAndStorePdfFromSnapshots } from "./pdf.ts";
export const voidReceipt = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const receiptId = ctx.req.param("receiptId") ?? "";
  const body = await ctx.req.json().catch(() => ({}));
  const reason = String(body?.reason ?? "").trim();

  if (!receiptId || !reason) {
    throw new AppError({
      message: "receiptId e reason são obrigatórios",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const existingRes = await postgres.query((db) =>
    db.query.receipt.findFirst({
      where: (r, ops) =>
        ops.and(
          ops.eq(r.id, receiptId),
          ops.eq(r.condominiumId, condominiumId),
        ),
    })
  );
  const existing = findEntityOrFail(existingRes, "Recibo");

  if (existing.voidedAt) {
    throw new AppError({
      message: "Recibo já está anulado",
      statusCode: STATUS_CODE.Conflict,
      code: "ALREADY_VOIDED",
    });
  }

  const actor = requireActor(ctx);

  const updated = await postgres.query((db) =>
    db.update(schema.receipt)
      .set({
        voidedAt: new Date(),
        voidedReason: reason,
        voidedBy: {
          id: actor.user_id ?? "",
          name: actor.email ?? (actor.user_id ?? ""),
          email: actor.email,
        },
        updatedAt: new Date(),
      })
      .where(eq(schema.receipt.id, receiptId))
      .returning()
  );

  // Re-renderiza PDF com a tarja "ANULADO" (best-effort - anulação já commitada; PDF falhado
  // regenera-se via scripts/regenerate_receipt.ts).
  const updatedReceipt = updated[0];
  if (updatedReceipt.storageEtag) {
    const { safePanelBaseUrl } = await import("$api/libs/shared/panel_base_url.ts");
    const panelBaseUrl = safePanelBaseUrl(ctx);
    try {
      await renderAndStorePdfFromSnapshots(postgres, updatedReceipt, panelBaseUrl);
    } catch (e) {
      console.error(`[receipt:${updatedReceipt.id}] regen PDF após void falhou:`, e);
    }
  }

  return ctx.json({ data: formatReceiptForResponse(updatedReceipt) });
};
