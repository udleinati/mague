// Dry-run da imputação (Art. 784.º CC) - sem writes. Reutiliza loadAndValidate +
// loadOpenCharges + planAllocation do execute, garantindo que o preview mostrado ao
// admin é EXATAMENTE o que a imputação real vai fazer (mesma elegibilidade, ordem e
// filtro por chargeType). Só para target `unit` (a tab "Fração" é a única com preview).

import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { eligibleSortedCharges, planAllocation } from "./plan.ts";
import { loadAndValidate, loadOpenCharges } from "./execute.ts";

export interface AllocationPreviewCharge {
  chargeId: string;
  description: string | null;
  chargeType: string;
  competencePeriod: string | null;
  status: string;
  openAmount: number;
  /** Quanto desta charge o movimento vai quitar (0 = não tocada). */
  amountToSettle: number;
  /** "full" = quita tudo o que está em aberto, "partial" = parcial, "none" = não tocada. */
  fill: "full" | "partial" | "none";
}

export interface AllocationPreviewResult {
  /** Todas as charges elegíveis, na ordem legal; as tocadas trazem amountToSettle > 0. */
  charges: AllocationPreviewCharge[];
  /** Excedente após quitar as charges - vira credit_balance à fração. */
  surplus: number;
  /** Valor absoluto do movimento. */
  txAmount: number;
  /** Σ já alocada a este movimento (conciliação parcial anterior). */
  alreadyAllocated: number;
  /** Valor ainda por distribuir (txAmount - alreadyAllocated). */
  remaining: number;
}

export interface PreviewAllocationInput {
  bankTransactionId: string;
  condominiumId: string;
  target: { kind: "unit"; unitId: string };
  chargeTypes?: string[];
}

export async function previewAllocation(
  input: PreviewAllocationInput,
  postgres: Postgres,
): Promise<AllocationPreviewResult> {
  const { bankTx, alreadyAllocated, today } = await loadAndValidate(input, postgres);
  const openCharges = await loadOpenCharges(input.target, bankTx.condominiumId, postgres);

  const txAmount = Math.abs(bankTx.amount);
  const plan = planAllocation({
    bankTxAmount: txAmount,
    alreadyAllocated,
    target: { kind: "unit" },
    openCharges,
    today,
    chargeTypes: input.chargeTypes,
  });

  const settleById = new Map(plan.entries.map((e) => [e.chargeId, e.amount]));
  const ordered = eligibleSortedCharges(openCharges, { kind: "unit" }, today, input.chargeTypes);

  const charges: AllocationPreviewCharge[] = ordered.map((c) => {
    const amountToSettle = settleById.get(c.id) ?? 0;
    const fill = amountToSettle <= 0 ? "none" : amountToSettle >= c.openAmount ? "full" : "partial";
    return {
      chargeId: c.id,
      description: c.description,
      chargeType: c.chargeType,
      competencePeriod: c.competencePeriod,
      status: c.status,
      openAmount: c.openAmount,
      amountToSettle,
      fill,
    };
  });

  return {
    charges,
    surplus: plan.surplus,
    txAmount,
    alreadyAllocated,
    remaining: Math.max(0, txAmount - alreadyAllocated),
  };
}
