// Projection de pathology: colunas seguras + format para response.
// Hide audit `deletedAt`/`deleted_by` + IP/UA do `createdBy`/`updatedBy`.

import type {
  AttachmentSelect,
  PathologySelect,
  TicketSelect,
  UnitSelect,
} from "$api/libs/postgres/schemas/mod.ts";

const PATHOLOGY_TOP_LEVEL_COLUMNS = {
  id: true,
  condominiumId: true,
  code: true,
  title: true,
  description: true,
  category: true,
  status: true,
  affectsCommonArea: true,
  resolutionNotes: true,
  dismissedReason: true,
  detectedAt: true,
  resolvedAt: true,
  dismissedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const PATHOLOGY_PROJECTION = {
  columns: PATHOLOGY_TOP_LEVEL_COLUMNS,
} as const;

type PathologyRowLike = Partial<PathologySelect> & {
  units?: { unit: Pick<UnitSelect, "id" | "designation" | "identifier"> | null }[];
  attachments?: AttachmentSelect[];
  tickets?: Pick<
    TicketSelect,
    "id" | "code" | "title" | "status" | "createdAt"
  >[];
};

// `units`/`attachments` só vêm via Drizzle relational; via `.returning()` num
// insert/update ficam vazios.
export function formatPathologyForResponse(row: PathologyRowLike) {
  const units = (row.units ?? [])
    .filter((u) => u.unit)
    .map((u) => ({
      id: u.unit!.id,
      designation: u.unit!.designation,
      identifier: u.unit!.identifier ?? null,
    }));
  return {
    id: row.id,
    condominiumId: row.condominiumId,
    code: row.code,
    title: row.title,
    description: row.description ?? null,
    category: row.category,
    status: row.status,
    affectsCommonArea: row.affectsCommonArea ?? false,
    units,
    resolutionNotes: row.resolutionNotes ?? null,
    dismissedReason: row.dismissedReason ?? null,
    detectedAt: row.detectedAt ?? null,
    resolvedAt: row.resolvedAt ?? null,
    dismissedAt: row.dismissedAt ?? null,
    attachments: (row.attachments ?? []).map(formatPathologyAttachmentForResponse),
    tickets: (row.tickets ?? []).map((t) => ({
      id: t.id,
      code: t.code,
      title: t.title,
      status: t.status,
      createdAt: t.createdAt,
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function formatPathologyAttachmentForResponse(row: Partial<AttachmentSelect>) {
  return {
    id: row.id,
    pathologyId: row.entityId,
    filename: row.filename,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    createdAt: row.createdAt,
  };
}
