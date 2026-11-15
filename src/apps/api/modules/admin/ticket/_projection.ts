// Projection de tickets/comments/attachments (mesmo padrão de charge/_projection.ts):
//   TICKET_PROJECTION              - columns whitelist (omite deletedAt).
//   formatTicketForResponse        - whitelist final + agrega listas.
//   formatTicketCommentForResponse / formatTicketAttachmentForResponse.

import type {
  PathologySelect,
  TicketAttachmentSelect,
  TicketCommentSelect,
  TicketSelect,
} from "$api/libs/postgres/schemas/mod.ts";

const TICKET_TOP_LEVEL_COLUMNS = {
  id: true,
  condominiumId: true,
  code: true,
  pathologyId: true,
  title: true,
  description: true,
  category: true,
  priority: true,
  status: true,
  unitId: true,
  location: true,
  visibility: true,
  resolvedAt: true,
  resolutionNotes: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  updatedBy: true,
} as const;

export const TICKET_PROJECTION = {
  columns: TICKET_TOP_LEVEL_COLUMNS,
} as const;

type TicketRowLike = Partial<TicketSelect> & {
  // Patologia associada (nested). null se pathology_id null ou soft-deleted.
  pathology?: Pick<PathologySelect, "id" | "code" | "title" | "status"> | null;
};

// Subset SEGURO do actor para responses: só email + user_id. O actor cru tem
// ip/user_agent/request_id que NUNCA saem pela API (ADR 0011).
function actorAsSubmitter(actor: TicketRowLike["createdBy"] | undefined) {
  if (!actor || typeof actor !== "object") return null;
  const email = (actor as { email?: string | null }).email ?? null;
  const userId = (actor as { user_id?: string | null }).user_id ?? null;
  if (!email && !userId) return null; // actor vazio = job/migration; nada a mostrar.
  return { email, userId };
}

export function formatTicketForResponse(
  row: TicketRowLike,
  comments: TicketCommentSelect[] = [],
  attachments: TicketAttachmentSelect[] = [],
) {
  return {
    id: row.id,
    condominiumId: row.condominiumId,
    code: row.code,
    pathologyId: row.pathologyId ?? null,
    pathology: row.pathology
      ? {
        id: row.pathology.id,
        code: row.pathology.code ?? null,
        title: row.pathology.title,
        status: row.pathology.status,
      }
      : null,
    title: row.title,
    description: row.description ?? null,
    category: row.category,
    priority: row.priority,
    status: row.status,
    unitId: row.unitId ?? null,
    location: row.location ?? null,
    visibility: row.visibility ?? "admin_only",
    resolvedAt: row.resolvedAt ?? null,
    resolutionNotes: row.resolutionNotes ?? null,
    submittedBy: actorAsSubmitter(row.createdBy),
    comments: comments.map(formatTicketCommentForResponse),
    attachments: attachments.map(formatTicketAttachmentForResponse),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type TicketCommentRowLike = Partial<TicketCommentSelect>;

export function formatTicketCommentForResponse(row: TicketCommentRowLike) {
  return {
    id: row.id,
    ticketId: row.ticketId,
    comment: row.comment,
    isInternal: row.isInternal,
    statusFrom: row.statusFrom ?? null,
    statusTo: row.statusTo ?? null,
    submittedBy: actorAsSubmitter(row.createdBy),
    createdAt: row.createdAt,
  };
}

type TicketAttachmentRowLike = Partial<TicketAttachmentSelect>;

export function formatTicketAttachmentForResponse(row: TicketAttachmentRowLike) {
  return {
    id: row.id,
    // Tabela polimórfica core.attachment: entity_type='ticket' + entity_id.
    ticketId: row.entityId,
    filename: row.filename,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    createdAt: row.createdAt,
  };
}
