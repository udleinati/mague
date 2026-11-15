// Projection partilhada pelos handlers de suppliers (ver charge/_projection.ts).

import type { SupplierSelect } from "$api/libs/postgres/schemas/supplier.ts";

const SUPPLIER_TOP_LEVEL_COLUMNS = {
  id: true,
  condominiumId: true,
  name: true,
  nif: true,
  contactName: true,
  contactEmail: true,
  contactPhone: true,
  accountId: true,
  notes: true,
  isActive: true,
  matchKeywords: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  updatedBy: true,
  deletedBy: true,
} as const;

export const SUPPLIER_PROJECTION = {
  columns: SUPPLIER_TOP_LEVEL_COLUMNS,
} as const;

type SupplierRowLike = Partial<SupplierSelect>;

export function formatSupplierForResponse(row: SupplierRowLike) {
  return {
    id: row.id,
    condominiumId: row.condominiumId,
    name: row.name,
    nif: row.nif,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    accountId: row.accountId,
    notes: row.notes,
    isActive: row.isActive,
    matchKeywords: row.matchKeywords ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
