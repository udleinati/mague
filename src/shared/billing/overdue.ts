// Deteção e composição de dívida em atraso para o lembrete de cobrança
// (ADR 0028). Pure functions - sem DB, sem HTTP. O caller
// (orchestrator no API) decide o ponto de referência (reconciledThroughDate vs
// today); a função só aplica a regra.
//
// Dívida é dívida: qualquer receivable de `nature='debit'` conta e dispara -
// quota, quota extraordinária, refaturação, saldo inicial. A mesma definição do
// painel (`v_unit_balance.overdue_debt_cents`), para os dois números baterem.

import { OVERDUE_THRESHOLD_DAYS } from "./reminder_eligibility.ts";

/** `kind` mapeia para `charge_type` (e.g. "quota", "refacturation"); NÃO o
 *  `charge.kind` (receivable/payable), já filtrado pelo caller. */
export interface ChargeLike {
  kind: string;
  /** `finance.charge.nature`. Só `debit` é dívida da fração; `credit` é crédito
   *  a favor dela e nunca entra no total (mesma regra do `v_unit_balance`). */
  nature: string;
  /** ISO `YYYY-MM-DD` ou null. Null nunca é "em atraso". */
  dueDate: string | null;
  /** `original_amount` em cêntimos. */
  amountCents: number;
  /** `settled_amount` em cêntimos; 0 = nada pago. */
  settledCents: number;
}

/** Dias de atraso de uma `dueDate` face a `reconciledThroughDate` (ADR 0028:
 *  referência é a conciliação, nunca `today`). Negativo = ainda por vencer. */
export function overdueDaysAgainst(
  reconciledThroughDate: string,
  dueDate: string,
): number {
  const ref = new Date(reconciledThroughDate + "T00:00:00Z");
  const due = new Date(dueDate + "T00:00:00Z");
  return Math.floor((ref.getTime() - due.getTime()) / 86_400_000);
}

/** true sse dívida em atraso > `thresholdDays` face a `reconciledThroughDate` e
 *  ainda por saldar. Default 30 (ADR 0028); o bloco +1d passa 0 (= vencida há
 *  >= 1 dia). Sem allowlist de `charge_type`: o que qualifica é ser débito. */
export function isChargeOverdueForBilling(
  charge: ChargeLike,
  reconciledThroughDate: string,
  thresholdDays: number = OVERDUE_THRESHOLD_DAYS,
): boolean {
  if (charge.nature !== "debit") return false;
  if (charge.dueDate === null) return false;
  if (charge.settledCents >= charge.amountCents) return false;
  return overdueDaysAgainst(reconciledThroughDate, charge.dueDate) > thresholdDays;
}

/** Linha do extrato a mostrar no email (subset da charge). */
export interface BillingEmailLine {
  kind: string;
  dueDate: string | null;
  amountCents: number;
  settledCents: number;
  /** amountCents - settledCents, nunca negativo. */
  outstandingCents: number;
}

export interface BillingEmailTotals {
  /** Total vencido: em-dívida de todas as charges com `dueDate <= ref`. */
  totalOwedCents: number;
  /** Subset de `totalOwedCents` vencido há mais de `overdueThresholdDays` face a
   *  `ref`. Coluna "Vencido" da listagem - o limiar acompanha o bloco
   *  selecionado (30/60/90). */
  overdueBeyondThresholdCents: number;
  /** Adiantamentos (settled > amount, e.g. FCR). Mostrado como "Tem crédito X". */
  creditCents: number;
  lines: BillingEmailLine[];
}

/** Inclui charges com `dueDate <= reconciledThroughDate` e débito a saldar; NÃO
 *  futuras (ADR 0028: email só fala do vencido). `overdueBeyondThresholdCents` é
 *  o subset vencido há mais de `overdueThresholdDays` (default 30; a listagem
 *  passa o limiar do bloco selecionado - ADR 0039). */
export function computeBillingEmailTotals(
  charges: ChargeLike[],
  reconciledThroughDate: string,
  overdueThresholdDays: number = OVERDUE_THRESHOLD_DAYS,
): BillingEmailTotals {
  const ref = new Date(reconciledThroughDate + "T00:00:00Z").getTime();
  const lines: BillingEmailLine[] = [];
  let totalOwedCents = 0;
  let overdueBeyondThresholdCents = 0;
  let creditCents = 0;
  for (const c of charges) {
    // Crédito = settled em excesso (FCR/imputação); conta para qualquer charge, mesmo futura.
    if (c.settledCents > c.amountCents) {
      creditCents += c.settledCents - c.amountCents;
      continue;
    }
    // Charge de nature='credit' (nota de crédito, saldo credor) não é dívida.
    if (c.nature !== "debit") continue;
    if (c.dueDate === null) continue;
    const due = new Date(c.dueDate + "T00:00:00Z").getTime();
    if (due > ref) continue; // futura - não entra no email
    const outstanding = c.amountCents - c.settledCents;
    if (outstanding <= 0) continue; // totalmente paga
    lines.push({
      kind: c.kind,
      dueDate: c.dueDate,
      amountCents: c.amountCents,
      settledCents: c.settledCents,
      outstandingCents: outstanding,
    });
    totalOwedCents += outstanding;
    if (overdueDaysAgainst(reconciledThroughDate, c.dueDate) > overdueThresholdDays) {
      overdueBeyondThresholdCents += outstanding;
    }
  }
  return { totalOwedCents, overdueBeyondThresholdCents, creditCents, lines };
}
