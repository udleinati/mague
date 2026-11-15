// POST /v1/admin/c/:cid/bank_transactions/:id/refund_supplier
//
// Devolução de fornecedor: entrada bancária (+€) que abate despesa anterior. Numa transação:
//   1. charge payable+credit (nota de crédito; fn_charge_ai não emite ledger para credit).
//   2. settlement bank_reconciliation com credit_charge_id (fn_settlement_ai: Dr Banco / Cr charge).
//   3. applySettlementEffects sincroniza open_amount da charge e status do bank_tx.
// Ao contrário de allocate_to_supplier (liquida faturas em aberto), cria charge credit nova.
// Ver docs/flows/02-fluxo-despesas.md, "Nota de crédito do fornecedor".

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { createSettlementInTx } from "$api/modules/admin/settlement/mod.ts";

const bodySchema = z.object({
  supplierId: z.string().min(1),
  sourceChargeId: z.string().min(1).optional(),
  amount: z.number().int().positive(),
  description: z.string().max(500).optional(),
  settlementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const refundSupplier = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);
  const bankTransactionId = requireParam(ctx, "id");
  const body = await dtoValidator(bodySchema, await ctx.req.json());

  const result = await postgres.transaction(async (tx) => {
    // ── 1. Validar bank_tx ────────────────────────────────────────────────
    const [bankTx] = await tx.select()
      .from(schema.bankTransaction)
      .where(and(
        eq(schema.bankTransaction.id, bankTransactionId),
        eq(schema.bankTransaction.condominiumId, condominiumId),
      ));
    if (!bankTx) {
      throw new AppError({
        message: `bank_transaction ${bankTransactionId} não encontrada`,
        statusCode: STATUS_CODE.NotFound,
        code: "NOT_FOUND",
      });
    }
    if (bankTx.amount <= 0) {
      throw new AppError({
        message: "Devolução de fornecedor exige movimento de entrada (crédito).",
        statusCode: STATUS_CODE.BadRequest,
        code: "WRONG_SIGN",
      });
    }
    if (bankTx.status !== "unreconciled" && bankTx.status !== "partial") {
      throw new AppError({
        message:
          `Movimento já está ${bankTx.status} - reverte primeiro se quiseres mudar a imputação.`,
        statusCode: STATUS_CODE.Conflict,
        code: "WRONG_STATUS",
      });
    }

    // ── 2. Validar supplier ───────────────────────────────────────────────
    // De outro condomínio = não encontrado: um 400 confirmava que o id existe lá.
    const [supplier] = await tx.select({
      id: schema.supplier.id,
      name: schema.supplier.name,
      accountId: schema.supplier.accountId,
    })
      .from(schema.supplier)
      .where(and(
        eq(schema.supplier.id, body.supplierId),
        eq(schema.supplier.condominiumId, condominiumId),
      ));
    if (!supplier) {
      throw new AppError({
        message: `supplier ${body.supplierId} não encontrado`,
        statusCode: STATUS_CODE.NotFound,
        code: "NOT_FOUND",
      });
    }

    // ── 3. Validar source charge (opcional) ───────────────────────────────
    let sourceCharge: typeof schema.charge.$inferSelect | null = null;
    if (body.sourceChargeId) {
      const [c] = await tx.select()
        .from(schema.charge)
        .where(and(
          eq(schema.charge.id, body.sourceChargeId),
          eq(schema.charge.condominiumId, condominiumId),
        ));
      if (!c) {
        throw new AppError({
          message: `charge ${body.sourceChargeId} não encontrada`,
          statusCode: STATUS_CODE.NotFound,
          code: "NOT_FOUND",
        });
      }
      if (c.kind !== "payable") {
        throw new AppError({
          message: `charge de origem tem de ser payable (atual: ${c.kind})`,
          statusCode: STATUS_CODE.BadRequest,
          code: "VALIDATION_ERROR",
        });
      }
      if (c.supplierId !== body.supplierId) {
        throw new AppError({
          message: "charge de origem é de outro fornecedor",
          statusCode: STATUS_CODE.BadRequest,
          code: "VALIDATION_ERROR",
        });
      }
      sourceCharge = c;
    }

    // ── 4. Criar charge payable+credit ────────────────────────────────────
    // (amount vs saldo não-alocado do bank_tx valida-se no createSettlementInTx)
    const settlementDate = body.settlementDate ?? bankTx.transactionDate;
    const description = body.description?.trim() ||
      (sourceCharge ? `Devolução: ${sourceCharge.description}` : `Devolução de ${supplier.name}`);

    const [newCharge] = await tx.insert(schema.charge).values({
      condominiumId,
      unitId: null,
      scope: "condominium",
      kind: "payable",
      nature: "credit",
      chargeType: "supplier_service",
      status: "open",
      issueDate: bankTx.transactionDate,
      dueDate: bankTx.transactionDate,
      competencePeriod: bankTx.transactionDate,
      originalAmount: body.amount,
      expectedAmount: body.amount,
      openAmount: body.amount,
      amount: 0,
      description,
      supplierId: body.supplierId,
      accountId: sourceCharge?.accountId ?? supplier.accountId ?? null,
      sourceType: sourceCharge ? "supplier_refund" : null,
      sourceId: sourceCharge?.id ?? null,
      createdBy: actor,
      updatedBy: actor,
    }).returning({ id: schema.charge.id });

    // ── 5. Settlement via o seam canónico (validação + ledger + effects) ──
    const { settlementId } = await createSettlementInTx(tx, {
      settlementType: "bank_reconciliation",
      condominiumId,
      unitId: null,
      amount: body.amount,
      settlementDate,
      notes: "Devolução de fornecedor",
      actor,
      bankTransactionId,
      debitChargeId: null,
      creditChargeId: newCharge.id,
    });

    // Re-lê o status final para devolver ao caller.
    const [refreshed] = await tx.select({ status: schema.bankTransaction.status })
      .from(schema.bankTransaction)
      .where(eq(schema.bankTransaction.id, bankTransactionId));

    return {
      chargeId: newCharge.id,
      settlementId,
      bankTransactionStatus: refreshed?.status ?? bankTx.status,
    };
  });

  return ctx.json({ data: result }, STATUS_CODE.Created);
};
