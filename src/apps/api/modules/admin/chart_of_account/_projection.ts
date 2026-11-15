// Projection partilhada pelos handlers de chart_of_accounts (padrão de charge/_projection.ts):
// CHART_OF_ACCOUNT_PROJECTION = whitelist de columns;
// formatChartOfAccountForResponse = whitelist + campo derivado isGlobal (condominiumId === null).

import type { ChartOfAccountSelect } from "$api/libs/postgres/schemas/chart_of_account.ts";

const CHART_OF_ACCOUNT_TOP_LEVEL_COLUMNS = {
  id: true,
  code: true,
  condominiumId: true,
  name: true,
  type: true,
  parentCode: true,
  isActive: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const CHART_OF_ACCOUNT_PROJECTION = {
  columns: CHART_OF_ACCOUNT_TOP_LEVEL_COLUMNS,
} as const;

type ChartOfAccountRowLike = Partial<ChartOfAccountSelect>;

export function formatChartOfAccountForResponse(row: ChartOfAccountRowLike) {
  return {
    id: row.id,
    code: row.code,
    condominiumId: row.condominiumId,
    // Globais (condominiumId=null) são partilhadas por todos os condomínios; locais são de um só.
    isGlobal: row.condominiumId === null,
    name: row.name,
    type: row.type,
    parentCode: row.parentCode,
    isActive: row.isActive,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
