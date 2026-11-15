// POST /v1/admin/condominiums/:cid/receipts/:receiptId/access - Body: { occupantId }.
// Regista o 1.º download do PDF por occupant (append-if-not-exists em `recipients_access`,
// write-once). Idempotente. Anti-IDOR: occupantId tem de estar no `recipients_snapshot`.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { sql } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import type { ReceiptAccessRecord, RecipientSnapshot } from "$api/libs/postgres/schemas/receipt.ts";

export const trackReceiptAccess = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const receiptId = ctx.req.param("receiptId") ?? "";
  const body = await ctx.req.json().catch(() => ({}));
  const occupantId = String(body?.occupantId ?? "").trim();

  if (!receiptId || !occupantId) {
    throw new AppError({
      message: "receiptId e occupantId são obrigatórios",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const receiptRes = await postgres.query((db) =>
    db.query.receipt.findFirst({
      where: (r, ops) =>
        ops.and(
          ops.eq(r.id, receiptId),
          ops.eq(r.condominiumId, condominiumId),
        ),
    })
  );
  const receipt = findEntityOrFail(receiptRes, "Recibo");

  // Anti-IDOR: occupant tem que ser dos recipients deste recibo.
  const recipients = (receipt.recipientsSnapshot ?? []) as RecipientSnapshot[];
  const isRecipient = recipients.some((r) => r.occupantId === occupantId);
  if (!isRecipient) {
    throw new AppError({
      message: "Occupant não é destinatário deste recibo",
      statusCode: STATUS_CODE.Forbidden,
      code: "NOT_RECIPIENT",
    });
  }

  // Idempotência: se já tem entry para este occupantId, no-op.
  const existing = (receipt.recipientsAccess ?? []) as ReceiptAccessRecord[];
  if (existing.some((a) => a.occupantId === occupantId)) {
    return ctx.json({ data: { tracked: false, reason: "already_recorded" } });
  }

  // Append. Snapshot do nome para evitar join na UI.
  const recipient = recipients.find((r) => r.occupantId === occupantId)!;
  const newRecord: ReceiptAccessRecord = {
    occupantId,
    firstDownloadedAt: new Date().toISOString(),
    occupantName: recipient.name,
  };

  // Append atómico via jsonb_insert (evita race conditions vs ler+escrever).
  await postgres.query((db) =>
    db.execute(sql`
      UPDATE finance.receipt
         SET recipients_access = COALESCE(recipients_access, '[]'::jsonb) ||
                                 ${JSON.stringify(newRecord)}::jsonb,
             updated_at = NOW()
       WHERE id = ${receiptId}
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(COALESCE(recipients_access, '[]'::jsonb)) AS a
            WHERE a->>'occupantId' = ${occupantId}
         )
    `)
  );

  return ctx.json({ data: { tracked: true, record: newRecord } }, STATUS_CODE.Created);
};
