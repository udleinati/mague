// Pure functions de transição de state machine para settlement effects.
// Sem DB, sem side-effects - testáveis diretamente.
//
// `effects.ts` faz I/O (load + UPDATE) à volta destas funções.

import { computeChargeStatus } from "./charge_status.ts";

export type EffectDirection = "forward" | "reverse";

export interface ChargeState {
  settledAmount: number;
  openAmount: number;
  amount: number;
  expectedAmount: number;
  originalAmount: number;
  status: string;
  dueDate: string | null;
}

export interface ChargeTransition {
  settledAmount: number;
  openAmount: number;
  amount: number;
  status: string;
}

// Perna de `charge_offset`: forward settled+=/open-=, reverse o inverso.
// `amount` da charge não muda (offset mexe só no saldo aberto, não na fatura).
export function computeOffsetSideTransition(
  charge: ChargeState,
  amount: number,
  direction: EffectDirection,
  today: Date,
): ChargeTransition {
  const sign = direction === "forward" ? 1 : -1;
  const newSettled = charge.settledAmount + sign * amount;
  const newOpen = charge.openAmount - sign * amount;
  const newStatus = computeChargeStatus(
    newSettled,
    newOpen,
    charge.dueDate,
    charge.status,
    today,
  );
  return {
    settledAmount: newSettled,
    openAmount: newOpen,
    amount: charge.amount,
    status: newStatus,
  };
}

// `bank_reconciliation`: ao contrário do offset, `amount` da charge muda e
// `open` é recalculado de expectedAmount (debit)/originalAmount (credit) - não
// de `open - amount` - para evitar drift após refaturações/ajustes.
export function computeBankReconciliationTransition(
  charge: ChargeState,
  isDebit: boolean,
  amount: number,
  direction: EffectDirection,
  today: Date,
): ChargeTransition {
  const sign = direction === "forward" ? 1 : -1;
  const newSettled = charge.settledAmount + sign * amount;
  const newAmount = charge.amount + sign * amount;
  const baseForOpen = isDebit ? charge.expectedAmount : charge.originalAmount;
  const newOpen = Math.max(baseForOpen - newSettled, 0);
  const newStatus = computeChargeStatus(
    newSettled,
    newOpen,
    charge.dueDate,
    charge.status,
    today,
  );
  return {
    settledAmount: newSettled,
    openAmount: newOpen,
    amount: newAmount,
    status: newStatus,
  };
}

// Status do bank_tx a partir do total alocado. Asimetria crítica: reverse sobre
// tx já 'reversed' mantém 'reversed' (não rebaixa); forward NÃO tem guard, pode
// mover de 'reversed' de volta a 'reconciled' (admin a refazer). Mirror de
// fn_settlement_ai.
export function computeBankTxStatus(
  currentStatus: string,
  allocated: number,
  absAmount: number,
  direction: EffectDirection,
): string {
  if (direction === "reverse" && currentStatus === "reversed") return "reversed";
  if (allocated >= absAmount) return "reconciled";
  if (allocated > 0) return "partial";
  return "unreconciled";
}
