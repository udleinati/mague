// Formatos canónicos de label para entidades de domínio (Fração, Fornecedor).
// Centralizam a regra "como se mostra esta entidade ao utilizador" - um só
// ficheiro a atualizar se a regra mudar.

/** Shape mínimo para o label de uma fração (aceita `Unit` ou rows mais leves). */
export interface UnitForLabel {
  id: string;
  designation: string;
  /** Coluna calculada: "Bloco X - Nº Letra" ou "Bloco X - Loja N". Pode ser null. */
  identifier?: string | null;
}

/**
 * Label canónico de uma fração:
 *   • com identifier  → "designation - identifier" (ex: "1ºE - Bloco A 1º Esq")
 *   • sem identifier  → "designation" (ex: "1ºE")
 *   • sem nada útil   → fallback para `id` (defensivo)
 */
export function unitLabel(unit: UnitForLabel): string {
  if (unit.identifier) return `${unit.designation} - ${unit.identifier}`;
  return unit.designation || unit.id;
}

/** Lookup `id -> label` para enriquecer listas onde só temos `unit_id`. */
export function unitLabelMap(units: ReadonlyArray<UnitForLabel>): Map<string, string> {
  return new Map(units.map((u) => [u.id, unitLabel(u)]));
}

export interface SupplierForLabel {
  id: string;
  name: string;
}

/** Só o nome; existe por simetria com `unitLabel`. */
export function supplierLabel(supplier: SupplierForLabel): string {
  return supplier.name;
}

/** Lookup `id -> label` a partir de uma lista de fornecedores. */
export function supplierLabelMap(
  suppliers: ReadonlyArray<SupplierForLabel>,
): Map<string, string> {
  return new Map(suppliers.map((s) => [s.id, supplierLabel(s)]));
}
