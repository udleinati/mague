// Completude das deliberações antes de selar a ata como realizada (`held`).
// Pure function (sem I/O) - consumida pelo API (enforcement no update de status)
// e testada isoladamente. Regra: cada ponto que se VOTA tem de ter resultado
// (`approved` true/false) antes de selar; pontos "info" não se votam. Pontos
// "Aprovar orçamento" têm ainda de indicar qual o orçamento (refId).

/** Shape mínimo de um ponto da ordem do dia para avaliar a deliberação. */
export interface DeliberableItem {
  sequence: number;
  subject: string;
  itemType: string | null;
  approved: boolean | null;
  refId: string | null;
}

export interface PendingDeliberations {
  /** Pontos votáveis ainda sem resultado (`approved` por registar). */
  undeliberated: DeliberableItem[];
  /** Pontos "Aprovar orçamento" já deliberados mas sem orçamento indicado. */
  missingBudgetRef: DeliberableItem[];
}

/** Pontos "info" não se votam; tudo o resto (incl. `other`/null) é votável. */
function isVotable(item: DeliberableItem): boolean {
  return item.itemType !== "info";
}

export function findPendingDeliberations(
  items: readonly DeliberableItem[],
): PendingDeliberations {
  const votable = items.filter(isVotable);
  return {
    undeliberated: votable.filter((i) => i.approved === null),
    // Só nos já deliberados: um ponto sem resultado já entra em `undeliberated`,
    // não o duplicamos aqui.
    missingBudgetRef: votable.filter(
      (i) => i.itemType === "approve_budget" && i.approved !== null && !i.refId,
    ),
  };
}

export function hasPendingDeliberations(p: PendingDeliberations): boolean {
  return p.undeliberated.length > 0 || p.missingBudgetRef.length > 0;
}
