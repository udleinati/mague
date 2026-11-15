// POST /v1/admin/condominiums/:cid/receipts/unskip - Body: { bankTransactionId, unitId, reason? }.
// Retoma uma tupla ignorada (soft-delete da row ativa em receipt_skip); volta a
// vw_pending_receipts. Idempotente: sem skip ativo, devolve { reactivated: false }.

import type { Context } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { receiptSkip, schema } from "$api/libs/postgres/schemas/mod.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";

export const unskipReceiptHandler = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const body = await ctx.req.json().catch(() => ({}));
  const bankTransactionId = String(body?.bankTransactionId ?? "").trim();
  const unitId = String(body?.unitId ?? "").trim();
  const reason = String(body?.reason ?? "").trim() || null;

  if (!bankTransactionId || !unitId) {
    throw new AppError({
      message: "bankTransactionId e unitId são obrigatórios",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const actor = requireActor(ctx);

  // Mesmo cross-tenant guard que skip.ts. Sem isto seria inert (UPDATE não acha row ativa de B),
  // mas validamos explicitamente para dar 422 imediato e evitar noise no audit log.
  const result = await postgres.query(async (db) => {
    const [bt, unit] = await Promise.all([
      db.query.bankTransaction.findFirst({
        where: (e, ops) =>
          ops.and(ops.eq(e.id, bankTransactionId), ops.eq(e.condominiumId, condominiumId)),
        columns: { id: true },
      }),
      db.query.unit.findFirst({
        where: byIdInCondo(schema.unit, unitId, condominiumId),
        columns: { id: true },
      }),
    ]);
    if (!bt || !unit) {
      throw new AppError({
        message: "bankTransactionId ou unitId não pertencem a este condomínio",
        statusCode: STATUS_CODE.UnprocessableEntity,
        code: "CROSS_TENANT_REJECTED",
      });
    }

    const [updated] = await db.update(receiptSkip)
      .set({
        deletedAt: new Date(),
        deletedBy: {
          id: actor.user_id ?? "",
          name: actor.email ?? (actor.user_id ?? ""),
          email: actor.email,
        },
        deletedReason: reason,
        updatedAt: new Date(),
      })
      .where(and(
        eq(receiptSkip.condominiumId, condominiumId),
        eq(receiptSkip.bankTransactionId, bankTransactionId),
        eq(receiptSkip.unitId, unitId),
        isNull(receiptSkip.deletedAt),
      ))
      .returning();
    return { reactivated: !!updated, skip: updated ?? null };
  });

  return ctx.json({ data: result });
};
