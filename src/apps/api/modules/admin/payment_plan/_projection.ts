// Projection de payment_plan: subset seguro para a response (esconde audit
// IP/UA + deleted_*). Ver ADR 0039.

import type { PaymentPlanSelect } from "$api/libs/postgres/schemas/mod.ts";

type PaymentPlanRowLike = Partial<PaymentPlanSelect>;

export function formatPaymentPlanForResponse(row: PaymentPlanRowLike) {
  return {
    id: row.id,
    condominiumId: row.condominiumId,
    unitId: row.unitId,
    status: row.status,
    notes: row.notes ?? null,
    internalNotes: row.internalNotes ?? null,
    endDate: row.endDate ?? null,
    endedAt: row.endedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
