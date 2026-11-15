// Validações puras de settlement antes do INSERT.
// Mirror das validações do trigger fn_settlement_bi (component 004).
// O trigger continua a existir como safety net até ao Stage 9.

import { AppError } from "$api/libs/error/app_error.ts";
import { STATUS_CODE } from "@std/http";

export type SettlementType = "bank_reconciliation" | "charge_offset" | "bank_deposit_credit";

export interface SettlementInput {
  settlementType: SettlementType;
  amount: number;
  bankTransactionId: string | null;
  debitChargeId: string | null;
  creditChargeId: string | null;
}

export interface ValidationContext {
  /** open_amount atual da debit charge (NULL se não existir) */
  debitChargeOpen: number | null;
  /** open_amount atual da credit charge (NULL se não existir) */
  creditChargeOpen: number | null;
  /** ABS(amount) da bank_tx (NULL se não existir) */
  bankTxAbs: number | null;
  /** Σ amount dos settlements ativos já existentes para a bank_tx */
  bankTxAlreadyAllocated: number;
}

/** Lança `AppError` em caso de invalidação. Retorna void em sucesso. */
export function validateSettlement(
  input: SettlementInput,
  ctx: ValidationContext,
): void {
  if (input.amount <= 0) {
    throwErr(`amount tem de ser > 0 (atual: ${input.amount})`, "VALIDATION_ERROR");
  }

  if (input.settlementType === "charge_offset") {
    if (input.debitChargeId === null || input.creditChargeId === null) {
      throwErr("charge_offset requer debit_charge_id E credit_charge_id", "VALIDATION_ERROR");
    }
    if (input.bankTransactionId !== null) {
      throwErr("charge_offset não pode ter bank_transaction_id", "VALIDATION_ERROR");
    }
    if (ctx.debitChargeOpen === null) {
      throwErr(
        `Charge de débito ${input.debitChargeId} não encontrada`,
        "NOT_FOUND",
        STATUS_CODE.NotFound,
      );
    }
    if (ctx.creditChargeOpen === null) {
      throwErr(
        `Charge de crédito ${input.creditChargeId} não encontrada`,
        "NOT_FOUND",
        STATUS_CODE.NotFound,
      );
    }
    if (input.amount > ctx.debitChargeOpen) {
      throwErr(
        `amount (${input.amount}) excede open_amount do débito (${ctx.debitChargeOpen})`,
        "VALIDATION_ERROR",
      );
    }
    if (input.amount > ctx.creditChargeOpen) {
      throwErr(
        `amount (${input.amount}) excede open_amount do crédito (${ctx.creditChargeOpen})`,
        "VALIDATION_ERROR",
      );
    }
    return;
  }

  if (input.settlementType === "bank_reconciliation") {
    if (input.bankTransactionId === null) {
      throwErr("bank_transaction_id é obrigatório para bank_reconciliation", "VALIDATION_ERROR");
    }
    if (ctx.bankTxAbs === null) {
      throwErr(
        `bank_transaction ${input.bankTransactionId} não encontrada`,
        "NOT_FOUND",
        STATUS_CODE.NotFound,
      );
    }
    const remaining = ctx.bankTxAbs - ctx.bankTxAlreadyAllocated;
    if (input.amount > remaining) {
      throwErr(
        `amount (${input.amount}) excede saldo não-alocado do bank_tx (${remaining} de ${ctx.bankTxAbs})`,
        "VALIDATION_ERROR",
      );
    }

    const hasDebit = input.debitChargeId !== null;
    const hasCredit = input.creditChargeId !== null;
    if (hasDebit === hasCredit) {
      throwErr(
        "bank_reconciliation requer debit_charge_id OU credit_charge_id (não ambos, não nenhum)",
        "VALIDATION_ERROR",
      );
    }

    if (hasDebit) {
      if (ctx.debitChargeOpen === null) {
        throwErr(
          `Charge de débito ${input.debitChargeId} não encontrada`,
          "NOT_FOUND",
          STATUS_CODE.NotFound,
        );
      }
      if (input.amount > ctx.debitChargeOpen) {
        throwErr(
          `amount (${input.amount}) excede open_amount do débito (${ctx.debitChargeOpen})`,
          "VALIDATION_ERROR",
        );
      }
    } else {
      if (ctx.creditChargeOpen === null) {
        throwErr(
          `Charge de crédito ${input.creditChargeId} não encontrada`,
          "NOT_FOUND",
          STATUS_CODE.NotFound,
        );
      }
      if (input.amount > ctx.creditChargeOpen) {
        throwErr(
          `amount (${input.amount}) excede open_amount do crédito (${ctx.creditChargeOpen})`,
          "VALIDATION_ERROR",
        );
      }
    }
    return;
  }

  if (input.settlementType === "bank_deposit_credit") {
    if (input.bankTransactionId === null) {
      throwErr("bank_transaction_id é obrigatório para bank_deposit_credit", "VALIDATION_ERROR");
    }
    if (input.creditChargeId === null) {
      throwErr("bank_deposit_credit requer credit_charge_id", "VALIDATION_ERROR");
    }
    if (input.debitChargeId !== null) {
      throwErr("bank_deposit_credit não pode ter debit_charge_id", "VALIDATION_ERROR");
    }
    if (ctx.bankTxAbs === null) {
      throwErr(
        `bank_transaction ${input.bankTransactionId} não encontrada`,
        "NOT_FOUND",
        STATUS_CODE.NotFound,
      );
    }
    const remaining = ctx.bankTxAbs - ctx.bankTxAlreadyAllocated;
    if (input.amount > remaining) {
      throwErr(
        `amount (${input.amount}) excede saldo não-alocado do bank_tx (${remaining} de ${ctx.bankTxAbs})`,
        "VALIDATION_ERROR",
      );
    }
    return;
  }

  throwErr(`settlement_type desconhecido: ${input.settlementType}`, "VALIDATION_ERROR");
}

function throwErr(
  message: string,
  code: string,
  statusCode: number = STATUS_CODE.BadRequest,
): never {
  throw new AppError({ message, statusCode, code });
}
