// Projection de inspeções + anexos (mesmo padrão de charge/_projection.ts):
//   INSPECTION_PROJECTION         - columns whitelist (omite deletedAt).
//   formatInspectionForResponse   - whitelist final + `status` derivado.
//   formatInspectionAttachmentForResponse.
// `computeInspectionStatus`/`InspectionStatus` exportados para testes/lógica externa.

import type {
  InspectionAttachmentSelect,
  InspectionSelect,
} from "$api/libs/postgres/schemas/mod.ts";

// Estado derivado (não persistido): inactive (is_active=false, sobrepõe) > expired
// (passou valid_until) > due_soon (janela de aviso) > ok.
export type InspectionStatus = "inactive" | "ok" | "due_soon" | "expired";

export function computeInspectionStatus(
  validUntil: string,
  notifyDaysBefore: number,
  isActive: boolean,
  todayIso: string,
): InspectionStatus {
  if (!isActive) return "inactive";
  if (validUntil <= todayIso) return "expired";
  const validTo = new Date(`${validUntil}T00:00:00Z`);
  const threshold = new Date(validTo.getTime() - notifyDaysBefore * 86_400_000);
  const thresholdIso = threshold.toISOString().slice(0, 10);
  return todayIso >= thresholdIso ? "due_soon" : "ok";
}

const INSPECTION_TOP_LEVEL_COLUMNS = {
  id: true,
  condominiumId: true,
  code: true,
  category: true,
  description: true,
  lastDoneDate: true,
  validUntil: true,
  notifyDaysBefore: true,
  notes: true,
  supplierId: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  updatedBy: true,
  deletedBy: true,
} as const;

const INSPECTION_NESTED_WITH = {
  supplier: {
    columns: {
      id: true,
      name: true,
      nif: true,
    },
  },
} as const;

export const INSPECTION_PROJECTION = {
  columns: INSPECTION_TOP_LEVEL_COLUMNS,
  with: INSPECTION_NESTED_WITH,
} as const;

// Subset estável do fornecedor (mesmo de charge/_projection.ts).
type InspectionNestedSupplier = {
  id: string;
  name: string;
  nif: string | null;
};

type InspectionRowLike = Partial<InspectionSelect> & {
  supplier?: InspectionNestedSupplier | null;
};

export function formatInspectionForResponse(
  row: InspectionRowLike,
  attachments: InspectionAttachmentSelect[] = [],
) {
  const today = new Date().toISOString().slice(0, 10);
  const status = (
      row.validUntil &&
      typeof row.notifyDaysBefore === "number" &&
      typeof row.isActive === "boolean"
    )
    ? computeInspectionStatus(
      row.validUntil,
      row.notifyDaysBefore,
      row.isActive,
      today,
    )
    : null;
  return {
    id: row.id,
    condominiumId: row.condominiumId,
    code: row.code ?? null,
    category: row.category,
    description: row.description,
    lastDoneDate: row.lastDoneDate,
    validUntil: row.validUntil,
    notifyDaysBefore: row.notifyDaysBefore,
    notes: row.notes,
    supplierId: row.supplierId ?? null,
    supplier: row.supplier ?? null,
    isActive: row.isActive ?? true,
    status,
    attachments: attachments.map(formatInspectionAttachmentForResponse),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type InspectionAttachmentRowLike = Partial<InspectionAttachmentSelect>;

export function formatInspectionAttachmentForResponse(row: InspectionAttachmentRowLike) {
  return {
    id: row.id,
    // Polimórfica core.attachment: caller garante o filtro por entity_type.
    inspectionId: row.entityId,
    filename: row.filename,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    createdAt: row.createdAt,
  };
}
