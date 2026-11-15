// Algoritmo puro de imputação - sem DB, sem side effects. Distribui o valor de um
// bank_tx por charges em aberto, seguindo a ordem legal de prioridade (Art. 784.º CC).
//
// Fração (kind='unit'): 1. juros (interest)  2. vencido/parcial (overdue/partial/due_date<hoje)
//   3. quotas correntes (quota/extraordinary_quota)  4. refaturações  5. outras.
//   Excedente → surplus (caller cria credit_balance + bank_deposit_credit).
// Fornecedor (kind='supplier'): 1. vencidas/parciais  2. outras. Excedente fica unallocated.
// Dentro de cada grupo: competence_period ASC, due_date ASC, created_at ASC.
// `chargeTypes` (opcional) restringe os tipos elegíveis antes da ordenação (ex: só extraordinárias).
//
// NOTA: prioridade distinta do auto-offset (charge/auto_offset.ts) - ver ADR 0035.

import type { ChargeSelect } from "$api/libs/postgres/schemas/charge.ts";

export type AllocationTarget =
  | { kind: "unit" }
  | { kind: "supplier" };

export interface AllocationPlanEntry {
  chargeId: string;
  amount: number; // sempre > 0
  group: number; // 1..5 para unit, 1..2 para supplier - para debug/explicação
  chargeType: string;
}

export interface AllocationPlan {
  entries: AllocationPlanEntry[];
  /**
   * Saldo restante após distribuir por charges.
   * - unit: caller deve criar credit_balance charge + bank_deposit_credit settlement.
   * - supplier: fica unallocated (caller ignora).
   */
  surplus: number;
}

/** Hoje de referência para "due_date < hoje → vencida"; por parâmetro = determinístico em testes. */
export type Today = Date;

interface PlanInput {
  bankTxAmount: number; // sempre absoluto (caller usa Math.abs do amount original)
  alreadyAllocated: number; // Σ settlement.amount já existentes para esta bank_tx
  target: AllocationTarget;
  openCharges: ReadonlyArray<ChargeSelect>;
  today: Today;
  /** Include-list de charge_type elegíveis; vazio/undefined = todos. Ex: só `extraordinary_quota`. */
  chargeTypes?: ReadonlyArray<string>;
}

export function planAllocation(input: PlanInput): AllocationPlan {
  const remaining = input.bankTxAmount - input.alreadyAllocated;
  if (remaining <= 0) return { entries: [], surplus: 0 };

  const sorted = eligibleSortedCharges(
    input.openCharges,
    input.target,
    input.today,
    input.chargeTypes,
  );

  const entries: AllocationPlanEntry[] = [];
  let left = remaining;

  for (const c of sorted) {
    if (left <= 0) break;
    if (c.openAmount <= 0) continue;
    const take = Math.min(left, c.openAmount);
    entries.push({
      chargeId: c.id,
      amount: take,
      group: priorityGroup(c, input.target, input.today),
      chargeType: c.chargeType,
    });
    left -= take;
  }

  return { entries, surplus: left };
}

/**
 * Charges elegíveis (filtradas por chargeTypes) já ordenadas por prioridade legal.
 * Exportada para o preview (dry-run) reusar EXATAMENTE a mesma elegibilidade e ordem
 * que o execute - evita divergência entre o que se mostra e o que se imputa.
 */
export function eligibleSortedCharges(
  charges: ReadonlyArray<ChargeSelect>,
  target: AllocationTarget,
  today: Today,
  chargeTypes?: ReadonlyArray<string>,
): ChargeSelect[] {
  const eligible = chargeTypes && chargeTypes.length
    ? charges.filter((c) => chargeTypes.includes(c.chargeType))
    : charges;
  return sortChargesByPriority(eligible, target, today);
}

function sortChargesByPriority(
  charges: ReadonlyArray<ChargeSelect>,
  target: AllocationTarget,
  today: Today,
): ChargeSelect[] {
  return [...charges].sort((a, b) => {
    const ga = priorityGroup(a, target, today);
    const gb = priorityGroup(b, target, today);
    if (ga !== gb) return ga - gb;

    // competence_period ASC NULLS LAST
    const cmp1 = compareNullableDate(a.competencePeriod, b.competencePeriod);
    if (cmp1 !== 0) return cmp1;

    // supplier também usa issue_date ASC NULLS LAST como tie-breaker antes de due_date
    if (target.kind === "supplier") {
      const cmp2 = compareNullableDate(a.issueDate, b.issueDate);
      if (cmp2 !== 0) return cmp2;
    }

    // due_date ASC NULLS LAST
    const cmp3 = compareNullableDate(a.dueDate, b.dueDate);
    if (cmp3 !== 0) return cmp3;

    // created_at ASC (sem NULLS - coluna é NOT NULL)
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

function priorityGroup(
  c: ChargeSelect,
  target: AllocationTarget,
  today: Today,
): number {
  if (target.kind === "supplier") {
    if (isOverdueOrPartial(c, today)) return 1;
    return 2;
  }
  // unit
  if (c.chargeType === "interest") return 1;
  if (isOverdueOrPartial(c, today)) return 2;
  if (c.chargeType === "quota" || c.chargeType === "extraordinary_quota") return 3;
  if (c.chargeType === "refacturation") return 4;
  return 5;
}

function isOverdueOrPartial(c: ChargeSelect, today: Today): boolean {
  if (c.status === "partial" || c.status === "overdue") return true;
  if (c.dueDate === null) return false;
  // dueDate é string YYYY-MM-DD (Drizzle date); comparação lexicográfica ok em ISO.
  return c.dueDate < toIsoDate(today);
}

function compareNullableDate(a: string | null, b: string | null): number {
  // NULLS LAST
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function toIsoDate(d: Date): string {
  // YYYY-MM-DD em UTC (alinhado com como Postgres trata `date` sem timezone)
  return d.toISOString().slice(0, 10);
}
