// Projection partilhada por todos os handlers que devolvem charges.
//   - `CHARGE_PROJECTION` - columns top-level + nested (whitelist na query).
//   - `formatChargeForResponse` - truncação YYYY-MM + default `null` nos nested
//     em call sites que não pediram `with` (create/update via `.returning()`).

import type { ChargeSelect } from "$api/libs/postgres/schemas/charge.ts";

// Top-level: omite `deletedAt` e `recurringTemplateId` (campos internos).
const CHARGE_TOP_LEVEL_COLUMNS = {
  id: true,
  code: true,
  condominiumId: true,
  unitId: true,
  scope: true,
  nature: true,
  kind: true,
  chargeType: true,
  status: true,
  issueDate: true,
  dueDate: true,
  competencePeriod: true,
  originalAmount: true,
  expectedAmount: true,
  settledAmount: true,
  openAmount: true,
  amount: true,
  description: true,
  // Nota interna do admin. O portal strip-a explicitamente (ver
  // `portal/charge.ts`) - nunca chega ao condómino.
  note: true,
  documentNumber: true,
  invoiceNumber: true,
  accountId: true,
  supplierId: true,
  contractId: true,
  paymentMethod: true,
  sourceType: true,
  sourceId: true,
  // Etiqueta manual despesa -> orçamento, lida pelo
  // relatório por Ata.
  budgetId: true,
  // Justificação do cancelamento - interna, o portal strip-a como a `note`.
  cancellationReason: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  updatedBy: true,
  deletedBy: true,
} as const;

const CHARGE_NESTED_WITH = {
  unit: {
    columns: {
      id: true,
      designation: true,
      identifier: true,
    },
  },
  supplier: {
    columns: {
      id: true,
      name: true,
      nif: true,
    },
  },
  account: {
    columns: {
      id: true,
      code: true,
      name: true,
      type: true,
    },
  },
} as const;

// `findMany`/`findFirst` config - espalha com `...CHARGE_PROJECTION`.
export const CHARGE_PROJECTION = {
  columns: CHARGE_TOP_LEVEL_COLUMNS,
  with: CHARGE_NESTED_WITH,
} as const;

// Tipos dos nested - derivados à mão (Drizzle não infere de config `as const`).
type ChargeNestedUnit = {
  id: string;
  designation: string;
  identifier: string | null;
};

type ChargeNestedSupplier = {
  id: string;
  name: string;
  nif: string | null;
};

type ChargeNestedAccount = {
  id: string;
  code: string;
  name: string;
  type: string;
};

// Input flex: aceita rows com nested (vindos da query relational) OU sem
// (vindos de `.returning()` no insert/update).
type ChargeRowLike = Partial<ChargeSelect> & {
  unit?: ChargeNestedUnit | null;
  supplier?: ChargeNestedSupplier | null;
  account?: ChargeNestedAccount | null;
};

// Truncação `competence_period` (YYYY-MM) + nested default `null`. A lista
// explícita é a whitelist final antes do JSON (defesa contra schema-drift).
export function formatChargeForResponse(row: ChargeRowLike) {
  return {
    id: row.id,
    code: row.code ?? null,
    condominiumId: row.condominiumId,
    unitId: row.unitId,
    scope: row.scope,
    nature: row.nature,
    kind: row.kind,
    chargeType: row.chargeType,
    status: row.status,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    // Competência é um mês: na BD é `date` com dia fixo em 01; trunca para YYYY-MM.
    competencePeriod: row.competencePeriod ? String(row.competencePeriod).slice(0, 7) : null,
    originalAmount: row.originalAmount,
    expectedAmount: row.expectedAmount,
    settledAmount: row.settledAmount,
    openAmount: row.openAmount,
    amount: row.amount,
    description: row.description,
    // Nota interna (admin). Portal omite via destructure no handler (anti-leak).
    note: row.note ?? null,
    documentNumber: row.documentNumber,
    invoiceNumber: row.invoiceNumber,
    accountId: row.accountId,
    supplierId: row.supplierId,
    contractId: row.contractId,
    paymentMethod: row.paymentMethod ?? "manual",
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    budgetId: row.budgetId ?? null,
    cancellationReason: row.cancellationReason ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    unit: row.unit ?? null,
    supplier: row.supplier ?? null,
    account: row.account ?? null,
  };
}
