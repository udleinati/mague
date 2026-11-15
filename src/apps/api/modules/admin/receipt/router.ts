import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { listPendingReceipts } from "./list_pending.ts";
import { listSkippedReceipts } from "./list_skipped.ts";
import { listReceipts } from "./list.ts";
import { getReceipt } from "./retrieve.ts";
import { emitReceiptHandler } from "./emit.ts";
import { emitBulkReceipts } from "./emit_bulk.ts";
import { skipReceiptHandler } from "./skip.ts";
import { unskipReceiptHandler } from "./unskip.ts";
import { voidReceipt } from "./void.ts";
import { resendReceiptEmail } from "./resend_email.ts";
import { serveReceiptPdf } from "./serve_pdf.ts";
import { trackReceiptAccess } from "./track_access.ts";

export const receiptRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/receipts";

  // /pending e /skipped têm que vir ANTES de /:receiptId para Hono não
  // interpretar como id.
  route.get(`${basePath}/pending`, (ctx) => listPendingReceipts(ctx, postgres));
  route.get(`${basePath}/skipped`, (ctx) => listSkippedReceipts(ctx, postgres));
  route.get(basePath, (ctx) => listReceipts(ctx, postgres));
  route.get(`${basePath}/:receiptId`, (ctx) => getReceipt(ctx, postgres));
  route.get(`${basePath}/:receiptId/pdf`, (ctx) => serveReceiptPdf(ctx, postgres));
  route.post(basePath, (ctx) => emitReceiptHandler(ctx, postgres));
  route.post(`${basePath}/bulk`, (ctx) => emitBulkReceipts(ctx, postgres));
  // Skip / unskip - marcam tupla (bank_tx, unit) como ignorada (soft delete em receipt_skip),
  // como o ignorar/retomar da conciliação mas por tupla em vez de por bank_tx.
  route.post(`${basePath}/skip`, (ctx) => skipReceiptHandler(ctx, postgres));
  route.post(`${basePath}/unskip`, (ctx) => unskipReceiptHandler(ctx, postgres));
  route.post(`${basePath}/:receiptId/void`, (ctx) => voidReceipt(ctx, postgres));
  route.post(`${basePath}/:receiptId/resend-email`, (ctx) => resendReceiptEmail(ctx, postgres));
  // Track first PDF download por occupant (portal, antes dos bytes). Idempotente; anti-IDOR:
  // occupant tem que ser recipient do recibo.
  route.post(`${basePath}/:receiptId/access`, (ctx) => trackReceiptAccess(ctx, postgres));

  return route;
};
