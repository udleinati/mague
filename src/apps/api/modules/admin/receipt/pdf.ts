// Render do HTML do recibo + materialização para PDF e upload S3.
//   - `renderReceiptHtml` - puro(-ish): HTML do row + snapshots; usado antes da row existir
//     na DB (shape em memória) e em re-render pós-void.
//   - `renderAndStorePdf` - HTML -> PDF -> S3 -> UPDATE etag/size/sha256;
//     `renderAndStorePdfFromSnapshots` regenera PDFs de recibos existentes (tarja "ANULADO").

import { eq } from "drizzle-orm";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { renderTemplate } from "$api/libs/templates/render.ts";
import { renderPdf } from "$api/libs/pdf/render.ts";
import { ensureBucket, putObject, type PutResult } from "$api/libs/storage/s3.ts";
import type { SnapshotsBundle } from "./_shared.ts";
import { amountInWords } from "./format.ts";

// Renderiza PDF dos snapshots, upload S3 e UPDATE etag/size/sha256/updated_at. Throws em
// falha (caller decide best-effort ou hard). Usado por emit, void e scripts/regenerate_receipt.ts.
export async function renderAndStorePdf(
  postgres: Postgres,
  receipt: typeof schema.receipt.$inferSelect,
  snapshots: SnapshotsBundle,
  panelBaseUrl: string,
): Promise<PutResult> {
  await ensureBucket();
  const html = await renderReceiptHtml(receipt, snapshots, panelBaseUrl);
  const pdfBytes = await renderPdf({ html });
  const put = await putObject(receipt.storageKey, pdfBytes, "application/pdf");
  await postgres.query((db) =>
    db.update(schema.receipt)
      .set({
        storageEtag: put.etag,
        fileSize: put.size,
        fileSha256: put.sha256,
        updatedAt: new Date(),
      })
      .where(eq(schema.receipt.id, receipt.id))
  );
  return put;
}

// Wrapper que extrai os snapshots da própria linha. Regenera PDF de recibos existentes
// (ex.: pós-void, tarja "ANULADO").
export function renderAndStorePdfFromSnapshots(
  postgres: Postgres,
  receipt: typeof schema.receipt.$inferSelect,
  panelBaseUrl: string,
): Promise<PutResult> {
  // Para snapshots stored sem `recipientsLive` (não está no JSONB), passa-se
  // array vazio - re-render só usa `recipients` (snapshot).
  return renderAndStorePdf(postgres, receipt, {
    condominium: receipt.condominiumSnapshot,
    unit: receipt.unitSnapshot,
    recipients: receipt.recipientsSnapshot,
    recipientsLive: [],
    lines: receipt.linesSnapshot,
    bankTx: receipt.bankTxSnapshot,
  }, panelBaseUrl);
}

export async function renderReceiptHtml(
  receipt: typeof schema.receipt.$inferSelect,
  snapshots: SnapshotsBundle,
  // Mantido por paridade com renderAndStorePdf; o recibo não tem QR (sem URL).
  _panelBaseUrl: string,
): Promise<string> {
  return await renderTemplate("receipt.vto", {
    receipt,
    condominium: snapshots.condominium,
    unit: snapshots.unit,
    recipients: snapshots.recipients,
    lines: snapshots.lines,
    bankTx: snapshots.bankTx,
    amountInWords: amountInWords(receipt.amountCents),
  });
}
