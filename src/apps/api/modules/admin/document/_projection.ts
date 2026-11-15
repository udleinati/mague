// Projection partilhada por todos os handlers admin de documentos.

import type { DocumentSelect } from "$api/libs/postgres/schemas/document.ts";

const DOCUMENT_TOP_LEVEL_COLUMNS = {
  id: true,
  condominiumId: true,
  title: true,
  description: true,
  category: true,
  isPublic: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  updatedBy: true,
  deletedBy: true,
} as const;

export const DOCUMENT_PROJECTION = {
  columns: DOCUMENT_TOP_LEVEL_COLUMNS,
} as const;

type DocumentRowLike = Partial<DocumentSelect>;

export function formatDocumentForResponse(row: DocumentRowLike) {
  return {
    id: row.id,
    condominiumId: row.condominiumId,
    title: row.title,
    description: row.description ?? null,
    category: row.category,
    isPublic: row.isPublic ?? false,
    publishedAt: row.publishedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
