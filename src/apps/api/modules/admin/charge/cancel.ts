// POST /charges/:chargeId/cancel { reason } - cancela uma charge com justificação.
// Numa transação: reverte os offsets (charge_offset) com outras charges da fração,
// passa a charge a 'cancelled' (fn_charge_bu zera os montantes, fn_charge_au anula o
// lançamento) e volta a aplicar o auto-offset às charges que ficaram livres.
// Pagamentos conciliados bloqueiam: revertem-se na conciliação (estorno).

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, asc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { reverseSettlement, type SettlementForEffects } from "$api/modules/admin/settlement/mod.ts";
import { formatChargeForResponse } from "./_projection.ts";
import { applyAutoOffset } from "./auto_offset.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

const bodySchema = z.object({
  reason: z.string().trim().min(10, "A justificação tem de ter pelo menos 10 caracteres").max(500),
});

// 'disputed' fica de fora: não é um estado a que a charge chegue por offset.
const CANCELLABLE_STATUSES = new Set(["open", "partial", "paid", "overdue"]);

export const cancelCharge = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const chargeId = requireParam(ctx, "chargeId");
  const { reason } = await dtoValidator(bodySchema, await ctx.req.json().catch(() => ({})));
  const actor = requireActor(ctx);
  const today = new Date();

  const updated = await postgres.transaction(async (tx) => {
    // FOR UPDATE serializa com createSettlementInTx, que tranca as mesmas charges.
    const [current] = await tx.select().from(schema.charge)
      .where(and(
        eq(schema.charge.id, chargeId),
        eq(schema.charge.condominiumId, condominiumId),
      ))
      .for("update");
    if (!current) {
      throw new AppError({
        message: "Charge não encontrada",
        statusCode: STATUS_CODE.NotFound,
        code: "NOT_FOUND",
      });
    }
    if (current.status === "cancelled") {
      throw new AppError({
        message: "Charge já está cancelada.",
        statusCode: STATUS_CODE.Conflict,
        code: "CHARGE_ALREADY_CANCELLED",
      });
    }
    if (!CANCELLABLE_STATUSES.has(current.status)) {
      throw new AppError({
        message: `Charge em estado '${current.status}' não pode ser cancelada.`,
        statusCode: STATUS_CODE.Conflict,
        code: "CHARGE_NOT_CANCELLABLE",
      });
    }

    const active = await tx.select({
      id: schema.settlement.id,
      settlementType: schema.settlement.settlementType,
      amount: schema.settlement.amount,
      debitChargeId: schema.settlement.debitChargeId,
      creditChargeId: schema.settlement.creditChargeId,
      bankTransactionId: schema.settlement.bankTransactionId,
    }).from(schema.settlement)
      .where(and(
        eq(schema.settlement.status, "active"),
        or(
          eq(schema.settlement.debitChargeId, chargeId),
          eq(schema.settlement.creditChargeId, chargeId),
        ),
      ))
      .orderBy(asc(schema.settlement.createdAt));

    if (active.some((s) => s.settlementType !== "charge_offset")) {
      throw new AppError({
        message:
          "A cobrança tem pagamentos conciliados com o banco. Reverte primeiro a conciliação do movimento.",
        statusCode: STATUS_CODE.Conflict,
        code: "CHARGE_HAS_BANK_SETTLEMENTS",
      });
    }

    const freedChargeIds: string[] = [];
    for (const s of active) {
      await reverseSettlement(tx, s as SettlementForEffects, reason, today);
      const otherId = s.debitChargeId === chargeId ? s.creditChargeId : s.debitChargeId;
      if (otherId && !freedChargeIds.includes(otherId)) freedChargeIds.push(otherId);
    }

    const [row] = await tx.update(schema.charge)
      .set({
        status: "cancelled",
        cancellationReason: reason,
        updatedAt: new Date(),
        updatedBy: actor,
      })
      .where(eq(schema.charge.id, chargeId))
      .returning();

    // O que a charge cancelada consumia volta ao auto-offset com o que está em aberto na fração.
    for (const otherId of freedChargeIds) {
      const [other] = await tx.select().from(schema.charge).where(eq(schema.charge.id, otherId));
      if (!other?.unitId) continue;
      await applyAutoOffset(tx, {
        chargeId: other.id,
        condominiumId,
        unitId: other.unitId,
        nature: other.nature as "debit" | "credit",
        openAmount: other.openAmount,
        status: other.status,
        kind: other.kind as "receivable" | "payable",
        // Data do novo offset: hoje, como a reversão (fn_settlement_au usa CURRENT_DATE).
        issueDate: today.toISOString().slice(0, 10),
        actor,
      }, today);
    }

    return row;
  });

  return ctx.json({ data: formatChargeForResponse(updated) }, STATUS_CODE.OK);
};
