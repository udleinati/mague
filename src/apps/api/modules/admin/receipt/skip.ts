// POST /v1/admin/condominiums/:cid/receipts/skip - Body: { bankTransactionId, unitId, reason? }.
// Marca a tupla (bank_tx, unit) como ignorada. Idempotente: skip ativo existente é devolvido
// (unique partial index garante 1 active row).

import type { Context } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { receiptSkip, schema } from "$api/libs/postgres/schemas/mod.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";

export const skipReceiptHandler = async (ctx: Context, postgres: Postgres) => {
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

  // Cross-tenant guard: bank_tx + unit têm de pertencer ao condo do path. FK só validam
  // existência, não ownership multi-tenant - sem isto, manager de A planta receipt_skip a
  // entidades de B (audit hole + leak via list_skipped).
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

    // Idempotência: se já há skip ativo, devolve-o.
    const existing = await db.query.receiptSkip.findFirst({
      where: and(
        eq(receiptSkip.condominiumId, condominiumId),
        eq(receiptSkip.bankTransactionId, bankTransactionId),
        eq(receiptSkip.unitId, unitId),
        isNull(receiptSkip.deletedAt),
      ),
    });
    if (existing) return existing;

    const [inserted] = await db.insert(receiptSkip).values({
      condominiumId,
      bankTransactionId,
      unitId,
      reason,
      skippedBy: {
        id: actor.user_id ?? "",
        name: actor.email ?? (actor.user_id ?? ""),
        email: actor.email,
      },
    }).returning();
    return inserted;
  });

  return ctx.json({ data: result }, STATUS_CODE.Created);
};
