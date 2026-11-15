// Enriquece bank_transactions com sugestões de match por palavras-chave (pure function).
// Por tx, procura units (amount > 0) ou suppliers (amount < 0) cujo match_keywords bate com a descrição:
//   1 match → sugere (suggested*);  >1 → conflito (matchConflictCount);  0 → row inalterada.

import { findKeywordMatches } from "$shared/match_keywords.ts";
import {
  type SupplierForLabel,
  supplierLabel,
  type UnitForLabel,
  unitLabel,
} from "$shared/labels/mod.ts";

interface BankTxLite {
  description?: string | null;
  amount: number;
}

interface UnitForMatch extends UnitForLabel {
  matchKeywords: readonly string[] | null;
}

interface SupplierForMatch extends SupplierForLabel {
  matchKeywords: readonly string[] | null;
}

export interface MatchSuggestion {
  suggestedKind?: "unit" | "supplier";
  suggestedUnitId?: string;
  suggestedSupplierId?: string;
  suggestedLabel?: string;
  matchConflictCount?: number;
}

/** Sugestão para 1 bank_tx: entrada (>0) → units, saída (<0) → suppliers, 0 → {}. */
export function suggestMatchFor(
  tx: BankTxLite,
  units: readonly UnitForMatch[],
  suppliers: readonly SupplierForMatch[],
): MatchSuggestion {
  const amount = Number(tx.amount ?? 0);
  if (amount === 0) return {};

  const candidates = amount > 0 ? units : suppliers;
  const matches = findKeywordMatches(
    tx.description,
    candidates as ReadonlyArray<{ id: string; matchKeywords?: readonly string[] | null }>,
  );

  if (matches.length === 0) return {};
  if (matches.length > 1) return { matchConflictCount: matches.length };

  const m = matches[0];
  if (amount > 0) {
    const u = m as UnitForMatch;
    return {
      suggestedKind: "unit",
      suggestedUnitId: u.id,
      suggestedLabel: unitLabel(u),
    };
  }
  const s = m as SupplierForMatch;
  return {
    suggestedKind: "supplier",
    suggestedSupplierId: s.id,
    suggestedLabel: supplierLabel(s),
  };
}

/** Aplica suggestMatchFor a uma lista; rows sem match ficam inalteradas. */
export function applyMatchSuggestions<T extends BankTxLite>(
  rows: T[],
  units: readonly UnitForMatch[],
  suppliers: readonly SupplierForMatch[],
): Array<T & MatchSuggestion> {
  return rows.map((tx) => ({ ...tx, ...suggestMatchFor(tx, units, suppliers) }));
}
