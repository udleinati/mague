// Ordem natural das designações de frações: A, B, ..., Z, AA, AB, ...
// (comprimento ASC, depois alfabético). Fonte única no SQL - ver ADR 0014.

import { type AnyColumn, asc, sql } from "drizzle-orm";

/**
 * Ordena uma coluna textual pela regra natural: comprimento ASC, depois valor
 * ASC. Sem `lower()` porque as designações reais são todas maiúsculas.
 */
export function unitNaturalOrder(col: AnyColumn) {
  return [sql`length(${col})`, asc(col)];
}
