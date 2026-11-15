// Builders de where-callbacks Drizzle para `core.assembly`. Pure, testáveis sem HTTP/DB.
// Invariantes (padrão ADR 0003): multi-tenant + soft-delete sempre; scope="public" força
// status != 'draft' (ver ASSEMBLY_PUBLIC_STATUSES) e ignora `?status=draft` (anti-vazamento).

import { ASSEMBLY_PUBLIC_STATUSES } from "$api/libs/enums.ts";

export type AssemblyScope = "all" | "public";

export interface AssemblyListFilters {
  condominiumId: string;
  scope: AssemblyScope;
  /** Filtro por status exato (UI admin). Em scope="public" ignora "draft". */
  status?: string | null;
}

export interface AssemblyDetailFilters {
  assemblyId: string;
  condominiumId: string;
  scope: AssemblyScope;
}

// Tipo "loose" do Drizzle ops/columns; o callback é invocado com os tipos reais.
// deno-lint-ignore no-explicit-any
type DrizzleOps = any;
// deno-lint-ignore no-explicit-any
type DrizzleColumns = any;

/** Where-callback para `findMany` em listagens de assembleias. */
export function buildAssemblyListWhere(opts: AssemblyListFilters) {
  return (e: DrizzleColumns, ops: DrizzleOps) => {
    const filters = [
      ops.eq(e.condominiumId, opts.condominiumId),
      ops.isNull(e.deletedAt),
    ];

    // Scope-driven visibility: portal só vê status != 'draft'.
    if (opts.scope === "public") {
      filters.push(ops.inArray(e.status, [...ASSEMBLY_PUBLIC_STATUSES]));
    }

    // Filtro por status individual (UI admin via `?status=`). Em scope="public"
    // ignora pedidos de "draft" silenciosamente (anti-vazamento).
    if (opts.status) {
      const safe = opts.scope === "all" || opts.status !== "draft";
      if (safe) filters.push(ops.eq(e.status, opts.status));
    }

    return ops.and(...filters);
  };
}

/** Where-callback para `findFirst` no detalhe de uma assembleia. */
export function buildAssemblyDetailWhere(opts: AssemblyDetailFilters) {
  return (e: DrizzleColumns, ops: DrizzleOps) => {
    const filters = [
      ops.eq(e.id, opts.assemblyId),
      ops.eq(e.condominiumId, opts.condominiumId),
      ops.isNull(e.deletedAt),
    ];
    if (opts.scope === "public") {
      filters.push(ops.inArray(e.status, [...ASSEMBLY_PUBLIC_STATUSES]));
    }
    return ops.and(...filters);
  };
}

/** Order-by canónico para listagens (mais recente primeiro pela data agendada). */
export function buildAssemblyListOrderBy() {
  return (e: DrizzleColumns, ops: DrizzleOps) => [ops.desc(e.scheduledAt)];
}
