// POST /bank_transactions/:id/ignore   - marca como 'ignored' (para ignorar
// transferências internas entre contas do condomínio que não precisam de ser
// conciliadas com charges).
// POST /bank_transactions/:id/unignore - volta a 'unreconciled'.
//
// Regras:
//   * Só tx com status='unreconciled' podem ser ignoradas.
//   * Só tx com status='ignored' podem ser retomadas.
//   * Nunca permitir se a tx tem settlements ativos (mexer com ledger).

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, sql } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { AppError } from "$api/libs/error/app_error.ts";

async function setStatus(
  ctx: Context,
  postgres: Postgres,
  from: "unreconciled" | "ignored",
  to: "unreconciled" | "ignored",
) {
  const condominiumId = requireCondominiumId(ctx);

  const txId = requireParam(ctx, "id");

  const existing = await postgres.query((db) =>
    db.query.bankTransaction.findFirst({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, txId),
          ops.eq(e.condominiumId, condominiumId),
        ),
    })
  );
  if (!existing) {
    throw new AppError({
      message: "bank_transaction não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  if (existing.status !== from) {
    throw new AppError({
      message: `Operação requer status='${from}', atual='${existing.status}'`,
      statusCode: STATUS_CODE.Conflict,
      code: "WRONG_STATUS",
    });
  }

  // settlement não tem soft-delete: reverse via status='reversed'.
  const activeSettlementCount = await postgres.query((db) =>
    db.select({ c: sql<number>`count(*)::int` })
      .from(schema.settlement)
      .where(and(
        eq(schema.settlement.bankTransactionId, txId),
        eq(schema.settlement.status, "active"),
      ))
  );
  if ((activeSettlementCount[0]?.c ?? 0) > 0) {
    throw new AppError({
      message: "Não é possível ignorar/retomar: existem settlements ativos. Reverte-os primeiro.",
      statusCode: STATUS_CODE.Conflict,
      code: "HAS_ACTIVE_SETTLEMENTS",
    });
  }

  const update = await postgres.query((db) =>
    db.update(schema.bankTransaction)
      .set({ status: to })
      .where(and(
        eq(schema.bankTransaction.id, txId),
        eq(schema.bankTransaction.condominiumId, condominiumId),
      ))
      .returning({ id: schema.bankTransaction.id, status: schema.bankTransaction.status })
  );

  return ctx.json({ data: update[0] });
}

export const ignoreBankTransaction = (ctx: Context, postgres: Postgres) =>
  setStatus(ctx, postgres, "unreconciled", "ignored");

export const unignoreBankTransaction = (ctx: Context, postgres: Postgres) =>
  setStatus(ctx, postgres, "ignored", "unreconciled");
