// Builders de queries para `core.pathology` (callbacks Drizzle relational).
// Pure, testáveis sem HTTP/DB. Invariantes (ADR 0003): multi-tenant + soft-delete
// sempre; scope "all" (admin) sem filtro de visibilidade, "public" (portal) força
// `status != 'draft'` (ADR 0024). Em scope="public", `status="draft"` no opts é
// IGNORADO (anti-vazamento de filtros admin).

import {
  PATHOLOGY_PUBLIC_STATUSES,
  type PathologyStatus,
} from "$api/libs/postgres/schemas/pathology.ts";

export type PathologyScope = "all" | "public";

// Buckets de status do portal (ADR 0024): active (vivos), resolved, dismissed.
// Nunca inclui `draft` (admin filtra draft por status individual, não por bucket).
export const PATHOLOGY_STATUS_GROUPS = {
  active: [
    "identified",
    "awaiting_quotes",
    "quote_approved",
    "awaiting_repair_start",
    "in_repair",
  ],
  resolved: ["resolved"],
  dismissed: ["dismissed"],
} as const satisfies Record<string, readonly PathologyStatus[]>;

export type PathologyStatusGroup = keyof typeof PATHOLOGY_STATUS_GROUPS;

export interface PathologyListFilters {
  condominiumId: string;
  scope: PathologyScope;
  /** Filtro por status exato (UI admin). Em scope="public" ignorado se for "draft". */
  status?: PathologyStatus | null;
  /** Filtro por bucket agregado (UI portal). Aplicado depois do status. */
  statusGroup?: PathologyStatusGroup | null;
}

export interface PathologyDetailFilters {
  pathologyId: string;
  condominiumId: string;
  scope: PathologyScope;
}

// Tipo "loose" do Drizzle ops/columns para o callback. Idem document/_query.ts.
// deno-lint-ignore no-explicit-any
type DrizzleOps = any;
// deno-lint-ignore no-explicit-any
type DrizzleColumns = any;

/** Where-callback para `findMany` em listagens de patologias. */
export function buildPathologyListWhere(opts: PathologyListFilters) {
  return (p: DrizzleColumns, ops: DrizzleOps) => {
    const filters = [
      ops.eq(p.condominiumId, opts.condominiumId),
      ops.isNull(p.deletedAt),
    ];

    // Scope-driven visibility: portal só vê status != 'draft'.
    if (opts.scope === "public") {
      filters.push(ops.inArray(p.status, [...PATHOLOGY_PUBLIC_STATUSES]));
    }

    // Filtro por status individual (UI admin). Em scope="public" ignora
    // pedidos de "draft" silenciosamente (anti-vazamento).
    if (opts.status) {
      const isPublicSafe = opts.scope === "all" || opts.status !== "draft";
      if (isPublicSafe) {
        filters.push(ops.eq(p.status, opts.status));
      }
    }

    // Filtro por bucket agregado (UI portal). Compatível com status
    // individual em simultâneo (ambos restringem; interseção).
    if (opts.statusGroup) {
      const statuses = PATHOLOGY_STATUS_GROUPS[opts.statusGroup];
      filters.push(ops.inArray(p.status, [...statuses]));
    }

    return ops.and(...filters);
  };
}

/** Where-callback para `findFirst` no detalhe de uma patologia. */
export function buildPathologyDetailWhere(opts: PathologyDetailFilters) {
  return (p: DrizzleColumns, ops: DrizzleOps) => {
    const filters = [
      ops.eq(p.id, opts.pathologyId),
      ops.eq(p.condominiumId, opts.condominiumId),
      ops.isNull(p.deletedAt),
    ];
    if (opts.scope === "public") {
      filters.push(ops.inArray(p.status, [...PATHOLOGY_PUBLIC_STATUSES]));
    }
    return ops.and(...filters);
  };
}

// Order-by canónico: detected_at DESC, tie-break created_at DESC.
export function buildPathologyListOrderBy() {
  return (p: DrizzleColumns, ops: DrizzleOps) => [
    ops.desc(p.detectedAt),
    ops.desc(p.createdAt),
  ];
}
