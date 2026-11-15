// Projections partilhadas pelos handlers de recurring templates/runs (padrão de charge/_projection.ts):
// RECURRING_TEMPLATE_PROJECTION = whitelist de columns (omite deletedAt);
// formatRecurringTemplateForResponse / formatRecurringGenerationRunForResponse = whitelist final.

import type { RecurringTemplateSelect } from "$api/libs/postgres/schemas/recurring_template.ts";
import type { RecurringGenerationRunSelect } from "$api/libs/postgres/schemas/recurring_generation_run.ts";

const RECURRING_TEMPLATE_TOP_LEVEL_COLUMNS = {
  id: true,
  condominiumId: true,
  kind: true,
  description: true,
  amount: true,
  accountId: true,
  supplierId: true,
  contractId: true,
  unitId: true,
  intervalType: true,
  paymentMethod: true,
  dayOfMonth: true,
  startDate: true,
  endDate: true,
  nextRunDate: true,
  lastGeneratedAt: true,
  isActive: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const RECURRING_TEMPLATE_PROJECTION = {
  columns: RECURRING_TEMPLATE_TOP_LEVEL_COLUMNS,
} as const;

type RecurringTemplateRowLike = Partial<RecurringTemplateSelect>;

export function formatRecurringTemplateForResponse(row: RecurringTemplateRowLike) {
  return {
    id: row.id,
    condominiumId: row.condominiumId,
    kind: row.kind,
    description: row.description,
    amount: row.amount,
    accountId: row.accountId,
    supplierId: row.supplierId,
    contractId: row.contractId,
    unitId: row.unitId,
    intervalType: row.intervalType,
    paymentMethod: row.paymentMethod,
    dayOfMonth: row.dayOfMonth,
    startDate: row.startDate,
    endDate: row.endDate,
    nextRunDate: row.nextRunDate,
    lastGeneratedAt: row.lastGeneratedAt,
    isActive: row.isActive,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type RecurringGenerationRunRowLike = Partial<RecurringGenerationRunSelect>;

export function formatRecurringGenerationRunForResponse(row: RecurringGenerationRunRowLike) {
  return {
    id: row.id,
    condominiumId: row.condominiumId,
    throughDate: row.throughDate,
    // A run não tem triggered_at/by (ADR 0011); mapeamos created_at/by p/ shape histórica.
    triggeredAt: row.createdAt,
    triggeredBy: row.createdBy?.user_id ?? null,
    templatesGenerated: row.templatesGenerated,
    chargesCreated: row.chargesCreated,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}
