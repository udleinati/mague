// SettlementOperation - API pública para criar/reverter settlements, tudo numa
// transação. Split: ledger via triggers fn_settlement_ai/au; validação via
// validateSettlement; charge/bank_tx state via apply{,Reverse}Effects.
// O cascade de reverter um bank_tx inteiro vive em bank_transaction/reverse.ts.

import { and, eq, sql } from "drizzle-orm";
import type { Postgres, TxClient } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import { type SettlementInput, type SettlementType, validateSettlement } from "./validate.ts";
import {
  type AppliedSettlementResult,
  applyReverseEffects,
  applySettlementEffects,
  type SettlementForEffects,
} from "./effects.ts";

export interface CreateSettlementInput {
  settlementType: SettlementType;
  condominiumId: string;
  unitId: string | null;
  amount: number;
  settlementDate: string;
  notes: string;
  /** ActorSnapshot completo (ADR 0011). `{}` aceitável para fluxos
   *  system-driven, mas cada handler API deve passar `requireActor(ctx)`. */
  actor: ActorSnapshot;
  bankTransactionId: string | null;
  debitChargeId: string | null;
  creditChargeId: string | null;
}

export interface CreateSettlementResult {
  settlementId: string;
  effects: AppliedSettlementResult;
}

/** Cria um settlement com cascade explícita (validation → INSERT → state updates). */
export async function createSettlement(
  input: CreateSettlementInput,
  postgres: Postgres,
  today: Date = new Date(),
): Promise<CreateSettlementResult> {
  return await postgres.transaction((tx) => createSettlementInTx(tx, input, today));
}

/** Núcleo tx-scoped partilhado por TODOS os produtores TS de settlements
 *  (manual, imputação, excedente, auto-offset, refund): validação canónica
 *  (locks FOR UPDATE) → INSERT (trigger fn_settlement_ai emite o ledger) →
 *  applySettlementEffects. NUNCA inserir settlement fora daqui (ADR 0001). */
export async function createSettlementInTx(
  tx: TxClient,
  input: CreateSettlementInput,
  today: Date = new Date(),
): Promise<CreateSettlementResult> {
  await validateInTx(tx, input);

  // Refs (metadata): perna com charge é 'charge'; a perna bancária cai no
  // lado sem charge (débito num depósito/refund, crédito num pagamento).
  const debitRefType = input.debitChargeId !== null
    ? "charge"
    : input.bankTransactionId !== null
    ? "bank_transaction"
    : null;
  const creditRefType = input.creditChargeId !== null
    ? "charge"
    : input.bankTransactionId !== null && input.debitChargeId !== null
    ? "bank_transaction"
    : null;

  const [inserted] = await tx.insert(schema.settlement).values({
    settlementType: input.settlementType,
    condominiumId: input.condominiumId,
    unitId: input.unitId,
    debitChargeId: input.debitChargeId,
    creditChargeId: input.creditChargeId,
    bankTransactionId: input.bankTransactionId,
    amount: input.amount,
    settlementDate: input.settlementDate,
    notes: input.notes,
    createdBy: input.actor,
    debitRefType,
    debitRefId: input.debitChargeId ??
      (debitRefType === "bank_transaction" ? input.bankTransactionId : null),
    creditRefType,
    creditRefId: input.creditChargeId ??
      (creditRefType === "bank_transaction" ? input.bankTransactionId : null),
  }).returning({ id: schema.settlement.id });

  // Trigger fn_settlement_ai já emitiu o ledger neste ponto.
  const settlementForEffects: SettlementForEffects = {
    id: inserted.id,
    settlementType: input.settlementType,
    amount: input.amount,
    debitChargeId: input.debitChargeId,
    creditChargeId: input.creditChargeId,
    bankTransactionId: input.bankTransactionId,
  };
  const effects = await applySettlementEffects(tx, settlementForEffects, today);
  return { settlementId: inserted.id, effects };
}

// Reverte 1 settlement (UPDATE 'reversed' + applyReverseEffects). Pré-condição:
// status==='active' - NÃO valida, o caller filtra e abrange tudo numa transação
// (ver bank_transaction/reverse.ts para o cascade).
export async function reverseSettlement(
  tx: TxClient,
  settlement: SettlementForEffects,
  reason: string,
  today: Date,
): Promise<AppliedSettlementResult> {
  await tx.update(schema.settlement)
    .set({
      status: "reversed",
      reversalReason: reason,
      reversedAt: new Date(),
    })
    .where(eq(schema.settlement.id, settlement.id));

  return await applyReverseEffects(tx, settlement, today);
}

// ── Validação dentro de transação (lookups às tabelas) ────────────────────

async function validateInTx(
  tx: TxClient,
  input: CreateSettlementInput,
): Promise<void> {
  const ctx: {
    debitChargeOpen: number | null;
    creditChargeOpen: number | null;
    bankTxAbs: number | null;
    bankTxAlreadyAllocated: number;
  } = {
    debitChargeOpen: null,
    creditChargeOpen: null,
    bankTxAbs: null,
    bankTxAlreadyAllocated: 0,
  };

  // Cross-tenant guard: charge/bank_tx têm de ser do mesmo condominium (FKs só
  // validam existência). `.for("update")` = race guard: dois settlements
  // paralelos contra a mesma charge não a deixam overpaid (openAmount negativo).
  if (input.debitChargeId !== null) {
    const [c] = await tx.select({ openAmount: schema.charge.openAmount })
      .from(schema.charge).where(and(
        eq(schema.charge.id, input.debitChargeId),
        eq(schema.charge.condominiumId, input.condominiumId),
      )).for("update");
    ctx.debitChargeOpen = c?.openAmount ?? null;
  }
  if (input.creditChargeId !== null) {
    const [c] = await tx.select({ openAmount: schema.charge.openAmount })
      .from(schema.charge).where(and(
        eq(schema.charge.id, input.creditChargeId),
        eq(schema.charge.condominiumId, input.condominiumId),
      )).for("update");
    ctx.creditChargeOpen = c?.openAmount ?? null;
  }
  if (input.bankTransactionId !== null) {
    const [bt] = await tx.select({ amount: schema.bankTransaction.amount })
      .from(schema.bankTransaction).where(and(
        eq(schema.bankTransaction.id, input.bankTransactionId),
        eq(schema.bankTransaction.condominiumId, input.condominiumId),
      )).for("update");
    ctx.bankTxAbs = bt ? Math.abs(bt.amount) : null;

    // Total já alocado a esta bank_tx (só settlements ativos).
    const [agg] = await tx.select({
      total: sql<string>`COALESCE(SUM(${schema.settlement.amount}), 0)`,
    }).from(schema.settlement).where(and(
      eq(schema.settlement.bankTransactionId, input.bankTransactionId),
      eq(schema.settlement.status, "active"),
    ));
    ctx.bankTxAlreadyAllocated = Number(agg.total);
  }

  validateSettlement(input as SettlementInput, ctx);
}
