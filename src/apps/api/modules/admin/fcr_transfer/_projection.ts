// Projection de fcr_transfer: subset seguro para a response (esconde o actor
// snapshot - ADR 0011).

import type { FcrTransferSelect } from "$api/libs/postgres/schemas/fcr_transfer.ts";

export function formatFcrTransferForResponse(row: Partial<FcrTransferSelect>) {
  return {
    id: row.id,
    condominiumId: row.condominiumId,
    direction: row.direction,
    amountCents: row.amountCents,
    transferDate: row.transferDate,
    reason: row.reason,
    createdAt: row.createdAt,
  };
}
