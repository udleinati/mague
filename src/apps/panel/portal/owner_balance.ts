// Balance restrito às charges de uma owner window. A view v_unit_balance
// agrega toda a unit sem janela; o portal precisa do saldo do owner atual,
// e a janela é dinâmica per-user (não cabe num WHERE estático). Paridade
// com a view (overdue: dueDate <= cutoff) - mudar uma, mudar a outra.

interface ChargeForBalance {
  nature: string;
  status: string;
  dueDate?: string | null;
  openAmount?: number | null;
}

export interface OwnerBalance {
  /** Σ openAmount de débitos open/partial/overdue. */
  openDebt: number;
  /** Σ openAmount de créditos open/partial/overdue (adiantamentos disponíveis). */
  openCredit: number;
  /** Subset de openDebt: dueDate <= reconciledThroughDate. 0 se cutoff for null. */
  overdueCents: number;
  /** Resto: openDebt - overdueCents. */
  futureDebtCents: number;
  /** Saldo líquido: openDebt - openCredit (positivo = unit deve, negativo = condo deve). */
  netCents: number;
}

/** Status de charge ainda em aberto (mesma regra da view v_unit_balance). */
function isOpenLikeStatus(s: string): boolean {
  return s === "open" || s === "partial" || s === "overdue";
}

// Balance das `charges` (já filtradas pela owner window pelo caller).
// `reconciledThroughDate` null → overdueCents = 0 (não acusar atraso sem cutoff).
export function computeOwnerBalance<T extends ChargeForBalance>(
  charges: readonly T[],
  reconciledThroughDate: string | null,
): OwnerBalance {
  let openDebt = 0;
  let openCredit = 0;
  let overdueCents = 0;

  for (const c of charges) {
    if (!isOpenLikeStatus(c.status)) continue;
    const amount = Number(c.openAmount ?? 0);
    if (c.nature === "debit") {
      openDebt += amount;
      if (
        reconciledThroughDate &&
        c.dueDate &&
        String(c.dueDate) <= reconciledThroughDate
      ) {
        overdueCents += amount;
      }
    } else if (c.nature === "credit") {
      openCredit += amount;
    }
  }

  return {
    openDebt,
    openCredit,
    overdueCents,
    futureDebtCents: openDebt - overdueCents,
    netCents: openDebt - openCredit,
  };
}
