// Regra de imputação despesa -> orçamento do relatório por Ata. Pura (sem BD)
// porque é aqui que mora o risco: contar a mesma fatura em duas obras, ou
// não contar nenhuma, muda o número que vai à assembleia.
//
// Ordem: etiqueta manual (`charge.budget_id`) ganha sempre.
// Sem etiqueta, infere-se pela rubrica + ano do orçamento. Se a rubrica
// pertence a MAIS do que um orçamento desse ano, a inferência não decide:
// a despesa fica `ambiguous`, aparece nos dois e não conta em nenhum.

export type ExpenseSource = "tagged" | "inferred" | "ambiguous";

export interface ImputableLine {
  budget_id: string;
  account_id: string;
}

export interface ImputablePayable {
  budget_id: string | null;
  account_id: string | null;
  /** YYYY-MM-DD; só o ano interessa para a inferência. */
  competence_period: string;
}

/** `accountId:ano` -> orçamentos que reclamam a rubrica nesse ano. */
export type AccountClaims = Map<string, string[]>;

export function buildAccountClaims(
  lines: ImputableLine[],
  budgetYear: Map<string, string>,
): AccountClaims {
  const claims: AccountClaims = new Map();
  for (const line of lines) {
    const year = budgetYear.get(line.budget_id);
    if (!year) continue;
    const key = claimKey(line.account_id, year);
    const list = claims.get(key) ?? [];
    if (!list.includes(line.budget_id)) list.push(line.budget_id);
    claims.set(key, list);
  }
  return claims;
}

export function claimKey(accountId: string, year: string): string {
  return `${accountId}:${year}`;
}

/** Rubrica disputada por mais do que um orçamento do mesmo ano. */
export function isAmbiguousAccount(
  claims: AccountClaims,
  accountId: string,
  year: string,
): boolean {
  return (claims.get(claimKey(accountId, year)) ?? []).length > 1;
}

/**
 * Orçamentos a que esta despesa conta, e com que confiança. Lista vazia = a
 * despesa não pertence a nenhum orçamento em relatório (rubrica fora deles,
 * ou etiqueta a apontar para um orçamento sem Ata).
 */
export function imputePayable(
  payable: ImputablePayable,
  claims: AccountClaims,
  reportedBudgetIds: ReadonlySet<string>,
): Array<{ budgetId: string; source: ExpenseSource }> {
  if (payable.budget_id && reportedBudgetIds.has(payable.budget_id)) {
    return [{ budgetId: payable.budget_id, source: "tagged" }];
  }
  if (!payable.account_id) return [];
  const year = payable.competence_period.slice(0, 4);
  const candidates = claims.get(claimKey(payable.account_id, year)) ?? [];
  if (candidates.length === 1) return [{ budgetId: candidates[0], source: "inferred" }];
  return candidates.map((budgetId) => ({ budgetId, source: "ambiguous" as const }));
}
