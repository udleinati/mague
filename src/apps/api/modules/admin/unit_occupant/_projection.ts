// Projection partilhada pelos handlers de unit_occupants (ver charge/_projection.ts).

import type { UnitOccupantSelect } from "$api/libs/postgres/schemas/unit_occupant.ts";

const UNIT_OCCUPANT_TOP_LEVEL_COLUMNS = {
  id: true,
  unitId: true,
  occupantId: true,
  relationshipType: true,
  startDate: true,
  endDate: true,
  createdAt: true,
} as const;

export const UNIT_OCCUPANT_PROJECTION = {
  columns: UNIT_OCCUPANT_TOP_LEVEL_COLUMNS,
} as const;

type UnitOccupantRowLike = Partial<UnitOccupantSelect>;

export function formatUnitOccupantForResponse(row: UnitOccupantRowLike) {
  return {
    id: row.id,
    unitId: row.unitId,
    occupantId: row.occupantId,
    relationshipType: row.relationshipType,
    startDate: row.startDate,
    endDate: row.endDate,
    createdAt: row.createdAt,
  };
}
