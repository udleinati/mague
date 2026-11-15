// Settlement effects - state machine bidireccional (forward + reverse).
// Atualiza charge.{settled,open,amount,status} + bank_tx.status; o ledger é dos
// triggers fn_settlement_ai/au. Os 3 settlement_types partilham o dispatcher;
// a única assimetria é o `bank_deposit_credit` reverse (guard "credit já
// consumida" + cancel da credit_balance).

import { and, eq, sql } from "drizzle-orm";
import type { TxClient } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { STATUS_CODE } from "@std/http";
import {
  computeBankReconciliationTransition,
  computeBankTxStatus,
  computeOffsetSideTransition,
  type EffectDirection,
} from "./effects_math.ts";

export type { EffectDirection };

export interface SettlementForEffects {
  id: string;
  settlementType: "bank_reconciliation" | "charge_offset" | "bank_deposit_credit";
  amount: number;
  debitChargeId: string | null;
  creditChargeId: string | null;
  bankTransactionId: string | null;
}

export interface ChargeStateBefore {
  id: string;
  settledAmount: number;
  openAmount: number;
  amount: number;
  expectedAmount: number;
  originalAmount: number;
  status: string;
  dueDate: string | null;
}

export interface ChargeStateAfter {
  settledAmount: number;
  openAmount: number;
  amount: number;
  status: string;
}

export interface AppliedSettlementResult {
  /** Charges atualizadas (id → before/after). */
  charges: Array<{ before: ChargeStateBefore; after: ChargeStateAfter }>;
  /** Novo status do bank_tx (NULL se settlement não tinha bank_tx). */
  bankTxStatus: string | null;
  /** Reverse de bank_deposit_credit cancela a credit_balance - id da charge cancelada. */
  cancelledChargeId: string | null;
}

// Forward: pré-condição settlement inserida; ledger fica a cargo de fn_settlement_ai.
export function applySettlementEffects(
  tx: TxClient,
  settlement: SettlementForEffects,
  today: Date,
): Promise<AppliedSettlementResult> {
  return applyEffects(tx, settlement, "forward", today);
}

// Reverse: pré-condição settlement.status já 'reversed' (UPDATE pelo caller, ver
// reverseSettlement em operation.ts); ledger fica a cargo de fn_settlement_au.
export function applyReverseEffects(
  tx: TxClient,
  settlement: SettlementForEffects,
  today: Date,
): Promise<AppliedSettlementResult> {
  return applyEffects(tx, settlement, "reverse", today);
}

// ── Dispatcher único (forward + reverse) ─────────────────────────────────

async function applyEffects(
  tx: TxClient,
  settlement: SettlementForEffects,
  direction: EffectDirection,
  today: Date,
): Promise<AppliedSettlementResult> {
  const result: AppliedSettlementResult = {
    charges: [],
    bankTxStatus: null,
    cancelledChargeId: null,
  };

  const directionLabel = direction === "forward" ? "" : " reversal";

  if (settlement.settlementType === "charge_offset") {
    if (!settlement.debitChargeId || !settlement.creditChargeId) {
      throw new Error(`charge_offset${directionLabel} sem debit/credit_charge_id`);
    }
    const debit = await loadCharge(tx, settlement.debitChargeId);
    const credit = await loadCharge(tx, settlement.creditChargeId);
    const debitAfter = computeOffsetSideTransition(debit, settlement.amount, direction, today);
    const creditAfter = computeOffsetSideTransition(credit, settlement.amount, direction, today);
    await persistChargeTransition(tx, debit.id, debitAfter, /*includeAmount*/ false);
    await persistChargeTransition(tx, credit.id, creditAfter, /*includeAmount*/ false);
    result.charges.push(
      { before: debit, after: debitAfter },
      { before: credit, after: creditAfter },
    );
    return result;
  }

  if (settlement.settlementType === "bank_deposit_credit") {
    if (!settlement.creditChargeId || !settlement.bankTransactionId) {
      throw new Error(`bank_deposit_credit${directionLabel} sem credit/bank_tx`);
    }
    if (direction === "reverse") {
      // Guard: bloqueia se a credit_balance já foi consumida por offsets ativos
      // (o admin tem de reverter esses offsets primeiro).
      const [{ count }] = await tx.select({
        count: sql<string>`COUNT(*)`,
      }).from(schema.settlement).where(and(
        eq(schema.settlement.settlementType, "charge_offset"),
        eq(schema.settlement.status, "active"),
        sql`(${schema.settlement.debitChargeId} = ${settlement.creditChargeId} OR ${schema.settlement.creditChargeId} = ${settlement.creditChargeId})`,
      ));
      if (Number(count) > 0) {
        throw new AppError({
          message:
            `Não é possível reverter o depósito: a credit_balance ${settlement.creditChargeId} já foi compensada com débitos. Reverta primeiro essas compensações.`,
          statusCode: STATUS_CODE.Conflict,
          code: "RESTRICT_VIOLATION",
        });
      }
      // Cancela a credit_balance (era a contrapartida do depósito).
      await tx.update(schema.charge)
        .set({ status: "cancelled", openAmount: 0 })
        .where(eq(schema.charge.id, settlement.creditChargeId));
      result.cancelledChargeId = settlement.creditChargeId;
    }
    // Forward: a credit_balance fica intacta - open_amount permanece para
    // ser consumido por offsets futuros. Apenas recalcula o bank_tx status.
    result.bankTxStatus = await recomputeBankTxStatus(tx, settlement.bankTransactionId, direction);
    return result;
  }

  if (settlement.settlementType === "bank_reconciliation") {
    if (!settlement.bankTransactionId) {
      throw new Error(`bank_reconciliation${directionLabel} sem bank_tx`);
    }
    const chargeId = settlement.debitChargeId ?? settlement.creditChargeId;
    if (!chargeId) throw new Error(`bank_reconciliation${directionLabel} sem charge`);
    const charge = await loadCharge(tx, chargeId);
    const isDebit = settlement.debitChargeId !== null;

    const after = computeBankReconciliationTransition(
      charge,
      isDebit,
      settlement.amount,
      direction,
      today,
    );
    await persistChargeTransition(tx, chargeId, after, /*includeAmount*/ true);

    result.charges.push({ before: charge, after });
    result.bankTxStatus = await recomputeBankTxStatus(tx, settlement.bankTransactionId, direction);
    return result;
  }

  throw new Error(`settlement_type inválido: ${settlement.settlementType}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function loadCharge(tx: TxClient, id: string): Promise<ChargeStateBefore> {
  const [row] = await tx.select({
    id: schema.charge.id,
    settledAmount: schema.charge.settledAmount,
    openAmount: schema.charge.openAmount,
    amount: schema.charge.amount,
    expectedAmount: schema.charge.expectedAmount,
    originalAmount: schema.charge.originalAmount,
    status: schema.charge.status,
    dueDate: schema.charge.dueDate,
  }).from(schema.charge).where(eq(schema.charge.id, id));
  if (!row) throw new Error(`charge ${id} não encontrada`);
  return row;
}

// includeAmount=false para offsets (não mudam `amount`), true para reconciliation.
async function persistChargeTransition(
  tx: TxClient,
  chargeId: string,
  after: ChargeStateAfter,
  includeAmount: boolean,
): Promise<void> {
  const set: Record<string, unknown> = {
    settledAmount: after.settledAmount,
    openAmount: after.openAmount,
    status: after.status,
  };
  if (includeAmount) set.amount = after.amount;
  await tx.update(schema.charge).set(set).where(eq(schema.charge.id, chargeId));
}

// I/O à volta de computeBankTxStatus (a asimetria forward/reverse vive lá).
async function recomputeBankTxStatus(
  tx: TxClient,
  bankTxId: string,
  direction: EffectDirection,
): Promise<string> {
  const [agg] = await tx.select({
    totalAllocated: sql<string>`COALESCE(SUM(${schema.settlement.amount}), 0)`,
  }).from(schema.settlement).where(and(
    eq(schema.settlement.bankTransactionId, bankTxId),
    eq(schema.settlement.status, "active"),
  ));
  const [bt] = await tx.select({
    amount: schema.bankTransaction.amount,
    status: schema.bankTransaction.status,
  }).from(schema.bankTransaction).where(eq(schema.bankTransaction.id, bankTxId));
  if (!bt) throw new Error(`bank_tx ${bankTxId} não encontrada`);

  const currentStatus = bt.status ?? "unreconciled";
  const newStatus = computeBankTxStatus(
    currentStatus,
    Number(agg.totalAllocated),
    Math.abs(bt.amount),
    direction,
  );

  // Idempotente: só faz UPDATE quando o status muda.
  if (newStatus !== currentStatus) {
    await tx.update(schema.bankTransaction).set({ status: newStatus }).where(
      eq(schema.bankTransaction.id, bankTxId),
    );
  }
  return newStatus;
}
