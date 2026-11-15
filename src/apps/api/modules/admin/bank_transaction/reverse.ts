// POST /v1/admin/c/:cid/bank-transactions/:id/reverse  { reason }
//
// Cascade explícita em TS.
//   1. UPDATE bank_tx.status='reversed' + reversal_reason
//   2. Para cada settlement ativo: `reverseSettlement` (UPDATE→reversed +
//      trigger emite ledger inverso + restore charge + recompute bank_tx)
//   3. Auto-void de recibos emitidos contra a tx (lógica TS dentro da
//      transação, não num trigger SQL; ver ADR 0001), + re-render dos PDFs
//      com a tarja "ANULADO" após o commit.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { reverseSettlement, type SettlementForEffects } from "$api/modules/admin/settlement/mod.ts";

const bodySchema = z.object({
  reason: z.string().trim().min(10, "Razão tem de ter pelo menos 10 caracteres").max(500),
});

export const reverseBankTransaction = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const txId = requireParam(ctx, "id");

  const { reason } = await dtoValidator(bodySchema, await ctx.req.json().catch(() => ({})));

  const result = await postgres.transaction(async (tx) => {
    // Carrega bank_tx + valida pré-condições
    const [bankTx] = await tx.select()
      .from(schema.bankTransaction)
      .where(and(
        eq(schema.bankTransaction.id, txId),
        eq(schema.bankTransaction.condominiumId, condominiumId),
      ));
    if (!bankTx) {
      throw new AppError({
        message: "bank_transaction não encontrada",
        statusCode: STATUS_CODE.NotFound,
        code: "NOT_FOUND",
      });
    }
    if (bankTx.status === "reversed") {
      throw new AppError({
        message: "Movimento já está revertido",
        statusCode: STATUS_CODE.Conflict,
        code: "ALREADY_REVERSED",
      });
    }
    if (bankTx.status !== "reconciled" && bankTx.status !== "partial") {
      throw new AppError({
        message:
          `Só movimentos conciliados (ou parciais) podem ser revertidos. Estado atual: ${bankTx.status}`,
        statusCode: STATUS_CODE.Conflict,
        code: "WRONG_STATUS",
      });
    }

    // 1. Marca bank_tx como reversed
    await tx.update(schema.bankTransaction)
      .set({ status: "reversed", reversalReason: reason })
      .where(eq(schema.bankTransaction.id, txId));

    // 2. Lista settlements ativos da bank_tx
    const activeSettlements = await tx.select({
      id: schema.settlement.id,
      settlementType: schema.settlement.settlementType,
      amount: schema.settlement.amount,
      debitChargeId: schema.settlement.debitChargeId,
      creditChargeId: schema.settlement.creditChargeId,
      bankTransactionId: schema.settlement.bankTransactionId,
    }).from(schema.settlement).where(and(
      eq(schema.settlement.bankTransactionId, txId),
      eq(schema.settlement.status, "active"),
    ));

    // 3. Reverte cada settlement (UPDATE → ledger inverso → restore charge).
    const today = new Date();
    const reversedSettlementIds: string[] = [];
    for (const s of activeSettlements) {
      const settlementForEffects: SettlementForEffects = {
        id: s.id,
        settlementType: s.settlementType as SettlementForEffects["settlementType"],
        amount: s.amount,
        debitChargeId: s.debitChargeId,
        creditChargeId: s.creditChargeId,
        bankTransactionId: s.bankTransactionId,
      };
      await reverseSettlement(tx, settlementForEffects, reason, today);
      reversedSettlementIds.push(s.id);
    }

    // 4. Auto-void de recibos (substitui trigger fn_bank_tx_au_void_receipt).
    // voidedBy: ActorSnapshot id="system" sinaliza ação automática (vs actor humano).
    const voidedReceipts = await tx.update(schema.receipt)
      .set({
        voidedAt: new Date(),
        voidedReason: "bank_tx_reversed",
        voidedBy: { id: "system", name: "Sistema (auto)", role: "system" },
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.receipt.bankTransactionId, txId),
        isNull(schema.receipt.voidedAt),
      ))
      .returning();

    return {
      id: txId,
      status: "reversed",
      reversalReason: reason,
      reversedSettlements: reversedSettlementIds,
      voidedReceipts,
    };
  });

  // Re-render dos PDFs com a tarja "ANULADO" - fora da transação (render+S3
  // demoram ~5s) e best-effort, como em receipt/void.ts. PDF falhado
  // regenera-se via scripts/regenerate_receipt.ts.
  const { safePanelBaseUrl } = await import("$api/libs/shared/panel_base_url.ts");
  const { renderAndStorePdfFromSnapshots } = await import("$api/modules/admin/receipt/pdf.ts");
  const panelBaseUrl = safePanelBaseUrl(ctx);
  for (const receipt of result.voidedReceipts) {
    if (!receipt.storageEtag) continue;
    try {
      await renderAndStorePdfFromSnapshots(postgres, receipt, panelBaseUrl);
    } catch (e) {
      console.error(`[receipt:${receipt.id}] regen PDF após reversão da bank_tx falhou:`, e);
    }
  }

  return ctx.json({
    data: {
      id: result.id,
      status: result.status,
      reversalReason: result.reversalReason,
      reversedSettlements: result.reversedSettlements,
      voidedReceipts: result.voidedReceipts.map((r) => r.id),
    },
  });
};
