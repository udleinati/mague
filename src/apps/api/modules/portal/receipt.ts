// /v1/portal/condominiums/:cid/units/:unitId/receipts - recibos da fração
// (unitId fixo no path). GET list/retrieve/pdf + POST track_access.

import type { Context } from "hono";
import { type AnyColumn, sql } from "drizzle-orm";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { getObject } from "$api/libs/storage/s3.ts";
import { loadUnitOwnedEntity, portalScope } from "$api/libs/portal/scope.ts";
import { inOwnerWindowSql, loadPortalOwnerWindow } from "$api/libs/portal/owner_window.ts";
import { parseLimit } from "$api/libs/shared/pagination.ts";
import {
  formatReceiptForResponse,
  RECEIPT_PROJECTION,
} from "$api/modules/admin/receipt/_projection.ts";
import type { ReceiptAccessRecord, RecipientSnapshot } from "$api/libs/postgres/schemas/receipt.ts";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 2000;

// Data do pagamento que o recibo titula (a mesma que o panel usa na janela).
const receiptTxDate = (snapshot: AnyColumn) => sql`${snapshot}->>'transactionDate'`;

export const portalListReceipts = async (ctx: Context, postgres: Postgres) => {
  const { cid: condominiumId, unitId } = portalScope(ctx);

  const yearStr = ctx.req.query("year");
  const voidedFilter = ctx.req.query("voided");
  const year = yearStr ? Number(yearStr) : null;
  const limit = parseLimit(ctx.req.query("limit"), { default: DEFAULT_LIMIT, max: MAX_LIMIT });
  const ownerWindow = await loadPortalOwnerWindow(ctx, postgres, unitId);

  const result = await postgres.query((db) =>
    db.query.receipt.findMany({
      where: (r, ops) =>
        ops.and(
          ops.eq(r.condominiumId, condominiumId),
          ops.eq(r.unitId, unitId),
          year != null ? ops.eq(r.year, year) : undefined,
          voidedFilter === "true" ? ops.isNotNull(r.voidedAt) : undefined,
          voidedFilter === "false" ? ops.isNull(r.voidedAt) : undefined,
          inOwnerWindowSql(receiptTxDate(r.bankTxSnapshot), ownerWindow),
        ),
      orderBy: (r, { desc }) => [desc(r.issuedAt)],
      limit,
      ...RECEIPT_PROJECTION,
    })
  );

  const data = result.map((row) => formatReceiptForResponse(row));
  return ctx.json({ data });
};

export const portalGetReceipt = async (ctx: Context, postgres: Postgres) => {
  const ownerWindow = await loadPortalOwnerWindow(ctx, postgres, portalScope(ctx).unitId);
  const { entity: receipt } = await loadUnitOwnedEntity({
    ctx,
    paramName: "receiptId",
    entityNamePT: "Recibo",
    fetch: ({ cid, unitId, id }, pg) =>
      pg.query((db) =>
        db.query.receipt.findFirst({
          where: (r, ops) =>
            ops.and(
              ops.eq(r.id, id),
              ops.eq(r.condominiumId, cid),
              ops.eq(r.unitId, unitId),
              inOwnerWindowSql(receiptTxDate(r.bankTxSnapshot), ownerWindow),
            ),
          ...RECEIPT_PROJECTION,
        })
      ),
  }, postgres);
  return ctx.json({ data: formatReceiptForResponse(receipt) });
};

/**
 * GET .../receipts/:receiptId/pdf - serve o PDF (proxy ao S3) com scope anti-IDOR
 * via `loadUnitOwnedEntity` (cid + unitId): só recibos da própria fração.
 */
export const portalServeReceiptPdf = async (ctx: Context, postgres: Postgres) => {
  const ownerWindow = await loadPortalOwnerWindow(ctx, postgres, portalScope(ctx).unitId);
  const { entity: receipt } = await loadUnitOwnedEntity({
    ctx,
    paramName: "receiptId",
    entityNamePT: "Recibo",
    fetch: ({ cid, unitId, id }, pg) =>
      pg.query((db) =>
        db.query.receipt.findFirst({
          where: (r, ops) =>
            ops.and(
              ops.eq(r.id, id),
              ops.eq(r.condominiumId, cid),
              ops.eq(r.unitId, unitId),
              inOwnerWindowSql(receiptTxDate(r.bankTxSnapshot), ownerWindow),
            ),
        })
      ),
  }, postgres);

  if (!receipt.storageEtag) {
    throw new AppError({
      message: "PDF ainda não foi gerado para este recibo",
      statusCode: STATUS_CODE.NotFound,
      code: "PDF_NOT_GENERATED",
    });
  }

  try {
    const bytes = await getObject(receipt.storageKey);
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

/**
 * POST .../track_access - regista que o occupant abriu o PDF. Anti-IDOR:
 * `occupantId` derivado do user logado (NÃO do body) e recibo confirmado na
 * `:unitId` do path. Idempotente (no-op em chamadas repetidas).
 */
export const portalTrackReceiptAccess = async (ctx: Context, postgres: Postgres) => {
  const actor = ctx.get("actor");
  if (!actor) {
    throw new AppError({
      message: "Sem sessão",
      statusCode: STATUS_CODE.Unauthorized,
      code: "AUTH_REQUIRED",
    });
  }
  const { scope: { cid: condominiumId }, id: receiptId, entity: receipt } =
    await loadUnitOwnedEntity({
      ctx,
      paramName: "receiptId",
      entityNamePT: "Recibo",
      fetch: ({ cid, unitId, id }, pg) =>
        pg.query((db) =>
          db.query.receipt.findFirst({
            where: (r, ops) =>
              ops.and(
                ops.eq(r.id, id),
                ops.eq(r.condominiumId, cid),
                ops.eq(r.unitId, unitId),
              ),
          })
        ),
    }, postgres);

  const occ = await postgres.query((db) =>
    db.query.occupant.findFirst({
      where: (o, ops) =>
        ops.and(
          ops.eq(o.userId, actor.user_id),
          ops.eq(o.condominiumId, condominiumId),
          ops.isNull(o.deletedAt),
        ),
      columns: { id: true },
    })
  );
  const occupantId = findEntityOrFail(occ, "Occupant").id;

  // Anti-IDOR: confirmar que o occupant está nos recipients_snapshot. Se
  // o admin emitiu o recibo para outros occupants, este não pode track.
  const recipients = (receipt.recipientsSnapshot ?? []) as RecipientSnapshot[];
  const recipient = recipients.find((r) => r.occupantId === occupantId);
  if (!recipient) {
    throw new AppError({
      message: "Não és destinatário deste recibo",
      statusCode: STATUS_CODE.Forbidden,
      code: "NOT_RECIPIENT",
    });
  }

  // Idempotência: se já tem entry, devolve no-op.
  const existing = (receipt.recipientsAccess ?? []) as ReceiptAccessRecord[];
  if (existing.some((a) => a.occupantId === occupantId)) {
    return ctx.json({ data: { tracked: false, reason: "already_recorded" } });
  }

  const newRecord: ReceiptAccessRecord = {
    occupantId,
    firstDownloadedAt: new Date().toISOString(),
    occupantName: recipient.name,
  };

  // Append atómico (NOT EXISTS protege concorrência).
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
