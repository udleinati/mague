// GET /v1/admin/condominiums/:cid/receipts/:receiptId/pdf - serve o PDF por proxy ao S3
// (não redirect), para callers server-side passarem pelo nosso auth. Download direto do
// browser prefere `pdfUrl` do GET /receipts/:id (URL pré-assinada, não carrega bytes na API).

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { getObject } from "$api/libs/storage/s3.ts";

export const serveReceiptPdf = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const receiptId = ctx.req.param("receiptId") ?? "";
  if (!receiptId) {
    throw new AppError({
      message: "receiptId é obrigatório",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }
  const result = await postgres.query((db) =>
    db.query.receipt.findFirst({
      where: (r, ops) =>
        ops.and(
          ops.eq(r.id, receiptId),
          ops.eq(r.condominiumId, condominiumId),
        ),
    })
  );
  const receipt = findEntityOrFail(result, "Recibo");

  if (!receipt.storageEtag) {
    throw new AppError({
      message: "PDF ainda não foi gerado para este recibo",
      statusCode: STATUS_CODE.NotFound,
      code: "PDF_NOT_GENERATED",
    });
  }

  try {
    const bytes = await getObject(receipt.storageKey);
    // Cast: Uint8Array<ArrayBufferLike> não casa com BodyInit em strict mode (TS rejeita
    // ArrayBufferLike). Mesmo workaround de minutes_pdf.ts/convocation_pdf.ts.
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="recibo-${
          (receipt.number ?? "").replace("/", "-")
        }.pdf"`,
        "cache-control": "private, max-age=3600",
      },
    });
  } catch (e) {
    throw new AppError({
      message: `Erro ao servir PDF: ${(e as Error).message}`,
      statusCode: STATUS_CODE.InternalServerError,
      code: "S3_ERROR",
    });
  }
};
