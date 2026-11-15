// Projection partilhada pelos handlers que devolvem units (ver charge/_projection.ts).

import { isNull } from "drizzle-orm";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import type { UnitSelect } from "$api/libs/postgres/schemas/unit.ts";
import type { OccupantSelect } from "$api/libs/postgres/schemas/occupant.ts";
import type { UnitOccupantSelect } from "$api/libs/postgres/schemas/unit_occupant.ts";

// Saldo agregado da fração (view `v_unit_balance`); ausente = zeros.
export interface UnitBalance {
  openDebtCents: number;
  openCreditCents: number;
  overdueDebtCents: number;
  // debt - credit: positivo = deve; negativo = tem crédito a favor.
  netCents: number;
}

const UNIT_TOP_LEVEL_COLUMNS = {
  id: true,
  condominiumId: true,
  designation: true,
  unitType: true,
  permillage: true,
  floor: true,
  door: true,
  block: true,
  identifier: true,
  description: true,
  matchKeywords: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  updatedBy: true,
  deletedBy: true,
} as const;

const UNIT_NESTED_WITH = {
  unitOccupants: {
    // Filtra associações soft-deleted: o nested embed do Drizzle não aplica
    // `deleted_at` automaticamente (serializer só cobria o do occupant).
    where: isNull(schema.unitOccupant.deletedAt),
    with: {
      occupant: true,
    },
  },
} as const;

export const UNIT_PROJECTION = {
  columns: UNIT_TOP_LEVEL_COLUMNS,
  with: UNIT_NESTED_WITH,
} as const;

// Aceita rows com unitOccupants (query relational) ou sem (`.returning()`).
type UnitRowLike = Partial<UnitSelect> & {
  unitOccupants?: (UnitOccupantSelect & { occupant: OccupantSelect })[];
};

export function formatUnitForResponse(
  row: UnitRowLike,
  opts: { balance?: UnitBalance; hasActivePlan?: boolean } = {},
) {
  const occupants = (row.unitOccupants ?? [])
    .filter((uo) => !uo.occupant.deletedAt)
    .map((uo) => ({
      id: uo.id,
      occupantId: uo.occupantId,
      relationshipType: uo.relationshipType,
      startDate: String(uo.startDate),
      endDate: uo.endDate ? String(uo.endDate) : null,
      createdAt: String(uo.createdAt),
      occupant: {
        id: uo.occupant.id,
        // Portal usa userId para saber QUAL occupant o user logado representa.
        userId: uo.occupant.userId ?? null,
        name: uo.occupant.name,
        email: uo.occupant.email,
        phone: uo.occupant.phone,
        nif: uo.occupant.nif,
        // Consumidos pelo `profile.vto` do portal (toggle + label de update).
        receiveReceiptEmails: uo.occupant.receiveReceiptEmails ?? false,
        updatedAt: uo.occupant.updatedAt,
      },
    }));

  return {
    id: row.id,
    condominiumId: row.condominiumId,
    designation: row.designation,
    unitType: row.unitType,
    permillage: row.permillage,
    floor: row.floor,
    door: row.door,
    block: row.block,
    identifier: row.identifier ?? null,
    description: row.description,
    matchKeywords: row.matchKeywords ?? [],
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    occupants,
    balance: opts.balance ?? {
      openDebtCents: 0,
      openCreditCents: 0,
      overdueDebtCents: 0,
      netCents: 0,
    },
    // Plano de pagamento ativo (ADR 0039) - badge na listagem/fração.
    hasActivePlan: opts.hasActivePlan ?? false,
  };
}
