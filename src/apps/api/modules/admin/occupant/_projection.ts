// Projection partilhada pelos handlers de occupants (ver charge/_projection.ts).

import type { OccupantSelect } from "$api/libs/postgres/schemas/occupant.ts";

const OCCUPANT_TOP_LEVEL_COLUMNS = {
  id: true,
  userId: true,
  name: true,
  email: true,
  nif: true,
  phone: true,
  personType: true,
  condominiumId: true,
  isActive: true,
  receiveReceiptEmails: true,
  firstLoginAt: true,
  lastLoginAt: true,
  lastLoginIp: true,
  lastLoginUserAgent: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  updatedBy: true,
  deletedBy: true,
} as const;

export const OCCUPANT_PROJECTION = {
  columns: OCCUPANT_TOP_LEVEL_COLUMNS,
} as const;

type OccupantRowLike = Partial<OccupantSelect>;

export function formatOccupantForResponse(row: OccupantRowLike) {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    email: row.email,
    nif: row.nif,
    phone: row.phone,
    personType: row.personType ?? "singular",
    condominiumId: row.condominiumId,
    isActive: row.isActive,
    receiveReceiptEmails: row.receiveReceiptEmails ?? true,
    // Tracking de login no portal, mostrado na página do ocupante (admin).
    firstLoginAt: row.firstLoginAt ?? null,
    lastLoginAt: row.lastLoginAt ?? null,
    lastLoginIp: row.lastLoginIp ?? null,
    lastLoginUserAgent: row.lastLoginUserAgent ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
