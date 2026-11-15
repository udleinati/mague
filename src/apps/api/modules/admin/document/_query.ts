// Builders de queries para `core.document` (callbacks Drizzle relational).
// Pure, testáveis sem HTTP/DB. Invariantes: multi-tenant + soft-delete sempre;
// scope "all" (admin) sem flag de visibilidade, "public" (portal) força
// is_public=true. Em scope="public", `isPublic` no opts é IGNORADO
// (anti-vazamento de filtros admin).

import type { DocumentCategory } from "$api/libs/postgres/schemas/document.ts";

export type DocumentScope = "all" | "public";

export interface DocumentListFilters {
  condominiumId: string;
  scope: DocumentScope;
  category?: DocumentCategory | null;
  /** Só aplicado quando scope="all". Em scope="public" é silenciosamente ignorado. */
  isPublic?: boolean | null;
}

export interface DocumentDetailFilters {
  documentId: string;
  condominiumId: string;
  scope: DocumentScope;
}

// Tipo "loose" do Drizzle ops/columns para o callback (forma estrutural basta).
// deno-lint-ignore no-explicit-any
type DrizzleOps = any;
// deno-lint-ignore no-explicit-any
type DrizzleColumns = any;

/** Where-callback para `findMany` em listagens de documentos. */
export function buildDocumentListWhere(opts: DocumentListFilters) {
  return (d: DrizzleColumns, ops: DrizzleOps) => {
    const filters = [
      ops.eq(d.condominiumId, opts.condominiumId),
      ops.isNull(d.deletedAt),
    ];

    // Scope-driven visibility.
    if (opts.scope === "public") {
      filters.push(ops.eq(d.isPublic, true));
    } else if (opts.isPublic === true || opts.isPublic === false) {
      filters.push(ops.eq(d.isPublic, opts.isPublic));
    }

    if (opts.category) {
      filters.push(ops.eq(d.category, opts.category));
    }

    return ops.and(...filters);
  };
}

/** Where-callback para `findFirst` no detalhe de um documento. */
export function buildDocumentDetailWhere(opts: DocumentDetailFilters) {
  return (d: DrizzleColumns, ops: DrizzleOps) => {
    const filters = [
      ops.eq(d.id, opts.documentId),
      ops.eq(d.condominiumId, opts.condominiumId),
      ops.isNull(d.deletedAt),
    ];
    if (opts.scope === "public") {
      filters.push(ops.eq(d.isPublic, true));
    }
    return ops.and(...filters);
  };
}

/** Order-by canónico para listagens (mais recente primeiro pela data oficial). */
export function buildDocumentListOrderBy() {
  return (d: DrizzleColumns, ops: DrizzleOps) => [
    ops.desc(d.publishedAt),
    ops.desc(d.createdAt),
  ];
}
