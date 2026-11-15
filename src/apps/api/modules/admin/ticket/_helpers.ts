// Helpers core de tickets: CRUD + comments + count via Drizzle (sem raw SQL).
// handlers.ts são thin wrappers destas funções.

import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { STATUS_CODE } from "@std/http";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { softDeleteAttachmentsForEntity } from "$api/libs/attachments/mod.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import type {
  AttachmentSelect,
  TicketCommentSelect,
  TicketSelect,
} from "$api/libs/postgres/schemas/mod.ts";

// Guard para mutações de conteúdo (comments + anexos): só em open/in_progress.
// Estados terminais (resolved/closed) congelam o registo. Mudança de estado e
// notas de resolução não passam por aqui (metadata).
export async function requireMutableTicket(
  postgres: Postgres,
  condominiumId: string,
  ticketId: string,
): Promise<void> {
  const t = await postgres.query((db) =>
    db.query.ticket.findFirst({
      where: byIdInCondo(schema.ticket, ticketId, condominiumId),
      columns: { status: true },
    })
  );
  if (!t) {
    throw new AppError({
      message: "Ocorrência não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  if (t.status !== "open" && t.status !== "in_progress") {
    throw new AppError({
      message:
        "Ocorrência em estado final - não permite adicionar nem remover conteúdo. Reverte para 'Em progresso' se precisares de editar.",
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "INVALID_STATE",
    });
  }
}

// Alias retro para callers que ainda referenciam o tipo antigo.
export type TicketAttachmentSelect = AttachmentSelect;

export interface ListTicketsFilters {
  status?: string;
  category?: string;
  priority?: string;
  /** Filtro estrito: só tickets desta fração. Usado pelo admin a filtrar. */
  unitId?: string;
  /**
   * Visão do portal desta fração (visibility): vê 'public' e
   * 'admin_unit' do próprio unit_id; nunca 'admin_only'. Não combinar com `unitId`.
   */
  forPortalUnit?: string;
}

export async function listTickets(
  postgres: Postgres,
  condominiumId: string,
  filters: ListTicketsFilters = {},
): Promise<TicketSelect[]> {
  const rows = await postgres.query((db) =>
    db.query.ticket.findMany({
      where: (t, ops) => {
        const conds = [
          ops.eq(t.condominiumId, condominiumId),
          ops.isNull(t.deletedAt),
        ];
        if (filters.status) conds.push(ops.eq(t.status, filters.status));
        if (filters.category) conds.push(ops.eq(t.category, filters.category));
        if (filters.priority) conds.push(ops.eq(t.priority, filters.priority));
        if (filters.unitId) conds.push(ops.eq(t.unitId, filters.unitId));
        if (filters.forPortalUnit) {
          // visibility='public' OR (visibility='admin_unit' AND unit_id=X).
          // admin_only nunca aparece no portal.
          conds.push(
            ops.or(
              ops.eq(t.visibility, "public"),
              ops.and(
                ops.eq(t.visibility, "admin_unit"),
                ops.eq(t.unitId, filters.forPortalUnit),
              )!,
            )!,
          );
        }
        return ops.and(...conds);
      },
      orderBy: (t, ops) => [ops.desc(t.createdAt)],
      limit: 200,
    })
  );
  return rows;
}

export async function getTicketWithRelated(
  postgres: Postgres,
  condominiumId: string,
  ticketId: string,
): Promise<
  | {
    ticket: TicketSelect;
    comments: TicketCommentSelect[];
    attachments: AttachmentSelect[];
  }
  | null
> {
  const ticketRow = await postgres.query((db) =>
    db.query.ticket.findFirst({
      where: byIdInCondo(schema.ticket, ticketId, condominiumId),
      with: {
        comments: {
          orderBy: (c, ops) => [ops.asc(c.createdAt)],
        },
        // Patologia associada (ADR 0024). Filtro deleted_at explícito porque
        // o nested with do Drizzle não o aplica.
        pathology: {
          where: isNull(schema.pathology.deletedAt),
          columns: { id: true, code: true, title: true, status: true },
        },
      },
    })
  );
  if (!ticketRow) return null;

  // Attachments na polimórfica `core.attachment`: query separada (mais simples
  // que JOIN cross-table polimórfica).
  const attachments = await postgres.query((db) =>
    db.query.attachment.findMany({
      where: (a, ops) =>
        ops.and(
          ops.eq(a.condominiumId, condominiumId),
          ops.eq(a.entityType, "ticket"),
          ops.eq(a.entityId, ticketId),
          ops.isNull(a.deletedAt),
        ),
      orderBy: (a, ops) => [ops.desc(a.createdAt)],
    })
  );

  const { comments, ...ticketBase } = ticketRow as TicketSelect & {
    comments: TicketCommentSelect[];
  };
  return {
    ticket: ticketBase as TicketSelect,
    comments: comments ?? [],
    attachments,
  };
}

export async function createTicket(
  postgres: Postgres,
  args: {
    condominiumId: string;
    actor: ActorSnapshot;
    data: {
      title: string;
      description?: string | null;
      category: string;
      priority?: string;
      unitId?: string | null;
      location?: string | null;
      visibility?: string;
      /** Ocupante que reportou (só no portal); alvo dos emails de interação. */
      reportedByOccupantId?: string | null;
    };
  },
): Promise<TicketSelect> {
  // admin_unit sem unitId viola o CHECK da BD; traduz para 422 antes do SQL.
  const visibility = args.data.visibility ?? "admin_only";
  if (visibility === "admin_unit" && !args.data.unitId) {
    throw new AppError({
      message: "Visibilidade 'administração + fração' requer fração associada.",
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "INVALID_INPUT",
    });
  }
  const inserted = await postgres.query((db) =>
    db.insert(schema.ticket).values({
      condominiumId: args.condominiumId,
      title: args.data.title,
      description: args.data.description ?? null,
      category: args.data.category,
      priority: args.data.priority ?? "normal",
      status: "open",
      unitId: args.data.unitId ?? null,
      location: args.data.location ?? null,
      visibility,
      reportedByOccupantId: args.data.reportedByOccupantId ?? null,
      createdBy: args.actor,
    }).returning()
  );
  return inserted[0];
}

export async function updateTicket(
  postgres: Postgres,
  args: {
    condominiumId: string;
    ticketId: string;
    actor: ActorSnapshot;
    patch: {
      title?: string;
      description?: string | null;
      category?: string;
      priority?: string;
      status?: string;
      unitId?: string | null;
      location?: string | null;
      visibility?: string;
      resolutionNotes?: string | null;
      pathologyId?: string | null;
    };
  },
): Promise<{ ticket: TicketSelect; statusChanged: boolean; oldStatus: string } | null> {
  const cur = await postgres.query((db) =>
    db.query.ticket.findFirst({
      where: byIdInCondo(schema.ticket, args.ticketId, args.condominiumId),
    })
  );
  if (!cur) return null;

  const oldStatus = cur.status;
  const newStatus = args.patch.status;
  const statusChanged = !!newStatus && newStatus !== oldStatus;

  const updateValues: Record<string, unknown> = {
    updatedBy: args.actor,
    updatedAt: new Date(),
  };
  if (args.patch.title !== undefined) updateValues.title = args.patch.title;
  if (args.patch.description !== undefined) updateValues.description = args.patch.description;
  if (args.patch.category !== undefined) updateValues.category = args.patch.category;
  if (args.patch.priority !== undefined) updateValues.priority = args.patch.priority;
  if (args.patch.status !== undefined) updateValues.status = args.patch.status;
  if (args.patch.unitId !== undefined) updateValues.unitId = args.patch.unitId;
  if (args.patch.location !== undefined) updateValues.location = args.patch.location;
  if (args.patch.visibility !== undefined) {
    // admin_unit exige unit_id efetivo (patch.unitId ?? cur.unitId); 422 antes do SQL.
    const effectiveUnitId = args.patch.unitId !== undefined ? args.patch.unitId : cur.unitId;
    if (args.patch.visibility === "admin_unit" && !effectiveUnitId) {
      throw new AppError({
        message: "Visibilidade 'administração + fração' requer fração associada.",
        statusCode: STATUS_CODE.UnprocessableEntity,
        code: "INVALID_INPUT",
      });
    }
    updateValues.visibility = args.patch.visibility;
  }
  if (args.patch.pathologyId !== undefined) updateValues.pathologyId = args.patch.pathologyId;
  if (args.patch.resolutionNotes !== undefined) {
    // Em `closed` as notas ficam congeladas - faz parte do registo final.
    // Permitir ainda quando o PATCH transiciona PARA closed (admin pode
    // escrever a nota e fechar na mesma request).
    if (
      oldStatus === "closed" && newStatus !== "open" && newStatus !== "in_progress" &&
      newStatus !== "resolved"
    ) {
      throw new AppError({
        message:
          "Ocorrência fechada - notas de resolução congeladas. Reverte para 'Em progresso' ou 'Resolvida' para editar.",
        statusCode: STATUS_CODE.UnprocessableEntity,
        code: "INVALID_STATE",
      });
    }
    updateValues.resolutionNotes = args.patch.resolutionNotes;
  }
  // resolvedAt: gerido automaticamente quando status muda para/de 'resolved'.
  if (newStatus === "resolved" && statusChanged) updateValues.resolvedAt = new Date();
  if (newStatus === "open" && statusChanged) updateValues.resolvedAt = null;

  const rows = await postgres.query((db) =>
    db.update(schema.ticket)
      .set(updateValues)
      .where(byIdInCondo(schema.ticket, args.ticketId, args.condominiumId))
      .returning()
  );
  const updated = rows[0];
  if (!updated) return null;
  return { ticket: updated, statusChanged, oldStatus };
}

export async function addComment(
  postgres: Postgres,
  args: {
    condominiumId: string;
    ticketId: string;
    actor: ActorSnapshot;
    comment: string;
    isInternal: boolean;
    statusFrom?: string;
    statusTo?: string;
  },
): Promise<TicketCommentSelect> {
  const inserted = await postgres.query((db) =>
    db.insert(schema.ticketComment).values({
      ticketId: args.ticketId,
      condominiumId: args.condominiumId,
      comment: args.comment,
      isInternal: args.isInternal,
      statusFrom: args.statusFrom ?? null,
      statusTo: args.statusTo ?? null,
      createdBy: args.actor,
    }).returning()
  );
  return inserted[0];
}

// Hard-delete (ticket_comment não tem soft-delete; auditoria via cdc_log).
export async function deleteComment(
  postgres: Postgres,
  args: {
    condominiumId: string;
    ticketId: string;
    commentId: string;
  },
): Promise<boolean> {
  const rows = await postgres.query((db) =>
    db.delete(schema.ticketComment)
      .where(and(
        eq(schema.ticketComment.id, args.commentId),
        eq(schema.ticketComment.ticketId, args.ticketId),
        eq(schema.ticketComment.condominiumId, args.condominiumId),
      ))
      .returning({ id: schema.ticketComment.id })
  );
  return rows.length > 0;
}

// Soft-delete + cascade S3 aos anexos (ADR 0021): apaga bytes do S3 PRIMEIRO,
// só depois soft-deleta. Fail-fast (deleteObject idempotente, admin pode retry).
// NOTA: recuperar o ticket (deleted_at=NULL) deixa anexos órfãos (bytes já idos).
export async function softDeleteTicket(
  postgres: Postgres,
  args: { condominiumId: string; ticketId: string; actor: ActorSnapshot },
): Promise<boolean> {
  // 1. Cascata S3 aos anexos vivos.
  await softDeleteAttachmentsForEntity({
    postgres,
    condominiumId: args.condominiumId,
    entityType: "ticket",
    entityId: args.ticketId,
    actor: args.actor,
  });

  // 2. Soft-delete do ticket (row fica para audit).
  const rows = await postgres.query((db) =>
    db.update(schema.ticket)
      .set({ deletedAt: new Date(), deletedBy: args.actor, updatedAt: new Date() })
      .where(byIdInCondo(schema.ticket, args.ticketId, args.condominiumId))
      .returning()
  );
  return rows.length > 0;
}

// Conta tickets open/in_progress (badge no menu admin).
export async function countOpenTickets(
  postgres: Postgres,
  condominiumId: string,
): Promise<number> {
  const rows = await postgres.query((db) =>
    db.select({ count: count() })
      .from(schema.ticket)
      .where(and(
        eq(schema.ticket.condominiumId, condominiumId),
        isNull(schema.ticket.deletedAt),
        inArray(schema.ticket.status, ["open", "in_progress"]),
      ))
  );
  return Number(rows[0]?.count ?? 0);
}
