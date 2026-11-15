// GET /v1/admin/condominiums/:cid/receipts/:receiptId - 1 recibo + PDF URL pré-assinada
// (5min TTL) para download direto do S3 sem proxy via API.

import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { formatReceiptForResponse, RECEIPT_PROJECTION } from "./_projection.ts";
import { presignedDownloadUrl } from "$api/libs/storage/s3.ts";

export const getReceipt = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const receiptId = requireParam(ctx, "receiptId");

  const result = await postgres.query((db) =>
    db.query.receipt.findFirst({
      where: (r, ops) =>
        ops.and(
          ops.eq(r.id, receiptId),
          ops.eq(r.condominiumId, condominiumId),
        ),
      ...RECEIPT_PROJECTION,
    })
  );
  const receipt = findEntityOrFail(result, "Recibo");

  // PDF URL pré-assinada (só se o ficheiro foi gravado no S3 - pode não ter
  // sido se o upload falhou após o INSERT).
  let pdfUrl: string | null = null;
  if (receipt.storageEtag) {
    try {
      pdfUrl = await presignedDownloadUrl(receipt.storageKey, 300);
    } catch (e) {
      console.error(`[receipt:${receipt.id}] presign falhou:`, e);
    }
  }

  return ctx.json({ data: formatReceiptForResponse(receipt, { pdfUrl }) });
};
