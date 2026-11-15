// Execução transacional da imputação (Art. 784.º CC). Pipeline em 4 fases:
//   1. loadAndValidate - bank_tx + target + alreadyAllocated (atira AppError em pré-cond falhada).
//   2. loadOpenCharges - charges debit em aberto do target.
//   3. planAllocation (puro) - { entries, surplus } por prioridade legal.
//   4. Em transação: applyPlanEntries + createCreditBalanceForSurplus (unit, surplus > 0).
// Fases (a)/(b) exportadas para reuso em testes/batch jobs; assumem caller já validou.

import { and, eq, sql } from "drizzle-orm";
import type { Postgres, TxClient } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { STATUS_CODE } from "@std/http";
import { createSettlementInTx } from "$api/modules/admin/settlement/mod.ts";
import { type AllocationPlanEntry, type AllocationTarget, planAllocation } from "./plan.ts";
import { monthStart } from "$api/modules/admin/recurring_template/date_helpers.ts";

/** Target da imputação, partilhado por execute e preview (dry-run). */
export type AllocationTargetRef =
  | { kind: "unit"; unitId: string }
  | { kind: "supplier"; supplierId: string };

export interface ExecuteAllocationInput {
  bankTransactionId: string;
  /** Condomínio do path: o movimento tem de ser dele (anti-IDOR). */
  condominiumId: string;
  target: AllocationTargetRef;
  /** ActorSnapshot completo (ADR 0011) - copiado para created_by do settlement e da credit_balance. */
  actor: ActorSnapshot;
  notes: string;
  /** Include-list de charge_type elegíveis; vazio/undefined = todos (ex: só extraordinárias). */
  chargeTypes?: string[];
}

export interface AllocationExecutionEntry {
  settlementId: string;
  chargeId: string;
  chargeType: string;
  amountAllocated: number;
  remainingAfter: number;
}

export interface AllocationExecutionResult {
  entries: AllocationExecutionEntry[];
  /** True quando houve surplus para fração e foi criada uma credit_balance + bank_deposit_credit. */
  surplusCharged: boolean;
}

/** Contexto partilhado pelas fases (a) e (b). Resolve uma vez no caller. */
export interface ApplyContext {
  bankTx: typeof schema.bankTransaction.$inferSelect;
  notes: string;
  actor: ActorSnapshot;
  today: Date;
}

export async function executeAllocation(
  input: ExecuteAllocationInput,
  postgres: Postgres,
): Promise<AllocationExecutionResult> {
  const { bankTx, alreadyAllocated, today } = await loadAndValidate(input, postgres);
  const openCharges = await loadOpenCharges(input.target, bankTx.condominiumId, postgres);

  const targetKind: AllocationTarget = { kind: input.target.kind };
  const plan = planAllocation({
    bankTxAmount: Math.abs(bankTx.amount),
    alreadyAllocated,
    target: targetKind,
    openCharges,
    today,
    chargeTypes: input.chargeTypes,
  });

  // Supplier sem charges em aberto → erro de domínio (matching legacy behaviour).
  if (input.target.kind === "supplier" && plan.entries.length === 0 && plan.surplus > 0) {
    throw new AppError({
      message: "Fornecedor não tem faturas em aberto neste condomínio.",
      statusCode: STATUS_CODE.BadRequest,
      code: "NO_OPEN_CHARGES",
    });
  }

  const ctx: ApplyContext = {
    bankTx,
    notes: input.notes,
    actor: input.actor,
    today,
  };

  return await postgres.transaction(async (tx) => {
    const totalAvailable = plan.entries.reduce((s, e) => s + e.amount, 0) + plan.surplus;
    const unitIdForRow = input.target.kind === "unit" ? input.target.unitId : null;

    const { executed, remaining } = await applyPlanEntries(
      tx,
      plan.entries,
      totalAvailable,
      unitIdForRow,
      ctx,
    );

    let surplusCharged = false;
    if (plan.surplus > 0 && input.target.kind === "unit" && remaining > 0) {
      const surplusEntry = await createCreditBalanceForSurplus(
        tx,
        remaining,
        input.target.unitId,
        ctx,
      );
      executed.push(surplusEntry);
      surplusCharged = true;
    }

    return { entries: executed, surplusCharged };
  });
}

// ── Fase 4a: aplicar entries do plan ────────────────────────────────────
//
// Por entry: re-lê open_amount e delega em createSettlementInTx (validação
// canónica + INSERT + effects num só seam - ver settlement/operation.ts).
// Cap = min(entry.amount, currentOpen, remaining) - defende contra caller concorrente
// (auto_offset, refacturation) que já consumiu parte da charge entre o plan e o execute.

export async function applyPlanEntries(
  tx: TxClient,
  entries: AllocationPlanEntry[],
  totalAvailable: number,
  unitIdForRow: string | null,
  ctx: ApplyContext,
): Promise<{ executed: AllocationExecutionEntry[]; remaining: number }> {
  const executed: AllocationExecutionEntry[] = [];
  let remaining = totalAvailable;

  for (const entry of entries) {
    const [current] = await tx
      .select({ openAmount: schema.charge.openAmount })
      .from(schema.charge)
      .where(and(
        eq(schema.charge.id, entry.chargeId),
        eq(schema.charge.condominiumId, ctx.bankTx.condominiumId),
      ));
    const currentOpen = current?.openAmount ?? 0;
    if (currentOpen <= 0) continue;

    const settleAmt = Math.min(entry.amount, currentOpen, remaining);
    if (settleAmt <= 0) continue;

    const { settlementId } = await createSettlementInTx(tx, {
      settlementType: "bank_reconciliation",
      condominiumId: ctx.bankTx.condominiumId,
      unitId: unitIdForRow,
      amount: settleAmt,
      settlementDate: ctx.bankTx.transactionDate,
      notes: ctx.notes,
      actor: ctx.actor,
      bankTransactionId: ctx.bankTx.id,
      debitChargeId: entry.chargeId,
      creditChargeId: null,
    }, ctx.today);

    remaining -= settleAmt;
    executed.push({
      settlementId,
      chargeId: entry.chargeId,
      chargeType: entry.chargeType,
      amountAllocated: settleAmt,
      remainingAfter: remaining,
    });
  }

  return { executed, remaining };
}

// ── Fase 4b: surplus → credit_balance + bank_deposit_credit ─────────────
//
// Só para target `unit`. A credit_balance é uma charge nature='credit'/receivable
// (crédito devolvido à fração; auto-offset por débitos futuros). NÃO emite ledger no
// INSERT (fn_charge_ai só emite nature='debit'); o ledger vem do bank_deposit_credit.

export async function createCreditBalanceForSurplus(
  tx: TxClient,
  remaining: number,
  unitId: string,
  ctx: ApplyContext,
): Promise<AllocationExecutionEntry> {
  const competence = monthStart(ctx.bankTx.transactionDate);

  const [credit] = await tx
    .insert(schema.charge)
    .values({
      condominiumId: ctx.bankTx.condominiumId,
      unitId,
      kind: "receivable",
      nature: "credit",
      chargeType: "credit_balance",
      status: "open",
      scope: "unit",
      issueDate: ctx.bankTx.transactionDate,
      dueDate: null,
      competencePeriod: competence,
      originalAmount: remaining,
      expectedAmount: remaining,
      openAmount: remaining,
      description: `${ctx.notes} - excedente`,
      sourceType: "bank_transaction",
      sourceId: ctx.bankTx.id,
      createdBy: ctx.actor,
    })
    .returning({ id: schema.charge.id });

  const { settlementId } = await createSettlementInTx(tx, {
    settlementType: "bank_deposit_credit",
    condominiumId: ctx.bankTx.condominiumId,
    unitId,
    amount: remaining,
    settlementDate: ctx.bankTx.transactionDate,
    notes: `${ctx.notes} - excedente registado em crédito`,
    actor: ctx.actor,
    bankTransactionId: ctx.bankTx.id,
    debitChargeId: null,
    creditChargeId: credit.id,
  }, ctx.today);

  return {
    settlementId,
    chargeId: credit.id,
    chargeType: "credit_balance",
    amountAllocated: remaining,
    remainingAfter: 0,
  };
}

// ── Helpers internos (validação + leitura) ──────────────────────────────

interface ValidatedContext {
  bankTx: typeof schema.bankTransaction.$inferSelect;
  alreadyAllocated: number;
  today: Date;
}

// Exportada para reuso pelo preview (dry-run): valida bank_tx + target + soma já alocada.
export async function loadAndValidate(
  input: { bankTransactionId: string; condominiumId: string; target: AllocationTargetRef },
  postgres: Postgres,
): Promise<ValidatedContext> {
  const today = new Date();

  return await postgres.query(async (db) => {
    const [bankTx] = await db
      .select()
      .from(schema.bankTransaction)
      .where(and(
        eq(schema.bankTransaction.id, input.bankTransactionId),
        eq(schema.bankTransaction.condominiumId, input.condominiumId),
      ));

    if (!bankTx) {
      throw new AppError({
        message: `bank_transaction ${input.bankTransactionId} não encontrada`,
        statusCode: STATUS_CODE.NotFound,
        code: "NOT_FOUND",
      });
    }

    if (input.target.kind === "unit" && bankTx.amount <= 0) {
      throw new AppError({
        message: "Imputação por fração exige movimento de entrada (crédito).",
        statusCode: STATUS_CODE.BadRequest,
        code: "WRONG_SIGN",
      });
    }
    if (input.target.kind === "supplier" && bankTx.amount >= 0) {
      throw new AppError({
        message: "Imputação por fornecedor exige movimento de saída (débito).",
        statusCode: STATUS_CODE.BadRequest,
        code: "WRONG_SIGN",
      });
    }

    if (bankTx.status === "ignored") {
      throw new AppError({
        message:
          `bank_tx ${input.bankTransactionId} está ignored - não pode ser alocada (retoma primeiro)`,
        statusCode: STATUS_CODE.BadRequest,
        code: "VALIDATION_ERROR",
      });
    }

    if (input.target.kind === "unit") {
      // De outro condomínio = não encontrada: um 400 confirmava que o id existe lá.
      const [unit] = await db
        .select({
          id: schema.unit.id,
          isActive: schema.unit.isActive,
        })
        .from(schema.unit)
        .where(and(
          eq(schema.unit.id, input.target.unitId),
          eq(schema.unit.condominiumId, bankTx.condominiumId),
        ));
      if (!unit) {
        throw new AppError({
          message: `unit ${input.target.unitId} não encontrada`,
          statusCode: STATUS_CODE.NotFound,
          code: "NOT_FOUND",
        });
      }
      if (unit.isActive !== true) {
        throw new AppError({
          message: `unit ${input.target.unitId} não está ativa`,
          statusCode: STATUS_CODE.BadRequest,
          code: "VALIDATION_ERROR",
        });
      }
    } else {
      const [supplier] = await db
        .select({ id: schema.supplier.id })
        .from(schema.supplier)
        .where(and(
          eq(schema.supplier.id, input.target.supplierId),
          eq(schema.supplier.condominiumId, bankTx.condominiumId),
        ));
      if (!supplier) {
        throw new AppError({
          message: `supplier ${input.target.supplierId} não encontrado`,
          statusCode: STATUS_CODE.NotFound,
          code: "NOT_FOUND",
        });
      }
    }

    const [{ total }] = await db
      .select({
        total: sql<string>`COALESCE(SUM(${schema.settlement.amount}), 0)`,
      })
      .from(schema.settlement)
      .where(
        and(
          eq(schema.settlement.bankTransactionId, input.bankTransactionId),
          eq(schema.settlement.status, "active"),
        ),
      );

    return {
      bankTx,
      alreadyAllocated: Number(total),
      today,
    };
  });
}

// Exportada para reuso pelo preview (dry-run). O filtro por chargeType NÃO é aplicado
// aqui - fica em planAllocation/eligibleSortedCharges (função pura), única fonte da regra.
export async function loadOpenCharges(
  target: AllocationTargetRef,
  condominiumId: string,
  postgres: Postgres,
): Promise<typeof schema.charge.$inferSelect[]> {
  return await postgres.query((db) => {
    const conditions = [
      eq(schema.charge.condominiumId, condominiumId),
      eq(schema.charge.nature, "debit"),
      sql`${schema.charge.status} IN ('open', 'partial', 'overdue')`,
      sql`${schema.charge.openAmount} > 0`,
    ];

    if (target.kind === "unit") {
      conditions.push(eq(schema.charge.unitId, target.unitId));
      conditions.push(eq(schema.charge.kind, "receivable"));
    } else {
      conditions.push(eq(schema.charge.supplierId, target.supplierId));
      conditions.push(eq(schema.charge.kind, "payable"));
    }

    return db.select().from(schema.charge).where(and(...conditions));
  });
}
