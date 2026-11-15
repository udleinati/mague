// /v1/portal/condominiums/:cid/units/:unitId/tickets - condóminos gerem
// ocorrências da SUA fração. `:unitId` fixo no path; handlers filtram por unitId
// (anti-IDOR). Só comments `isInternal=false` são expostos; write limitado ao scope.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { loadUnitOwnedEntity, portalScope } from "$api/libs/portal/scope.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { safePanelBaseUrl } from "$api/libs/shared/panel_base_url.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import {
  addComment,
  createTicket,
  getTicketWithRelated,
  listTickets,
  softDeleteTicket,
  updateTicket,
} from "$api/modules/admin/ticket/_helpers.ts";
import { notifyTicketActivity, notifyTicketCreated } from "$api/modules/admin/ticket/_notify.ts";
import {
  formatTicketAttachmentForResponse,
  formatTicketForResponse,
} from "$api/modules/admin/ticket/_projection.ts";
import { makeAttachmentManager } from "$api/libs/attachments/manager.ts";
import type { AttachmentSelect } from "$api/libs/postgres/schemas/attachment.ts";

// Anti-IDOR: o ticket tem de pertencer ao condomínio do path.
const portalTicketAttachmentManager = makeAttachmentManager({
  entityType: "ticket",
  paramName: "ticketId",
  entityNamePT: "Ocorrência",
  ownershipQuery: (postgres, ticketId, condominiumId) =>
    postgres.query((db) =>
      db.query.ticket.findFirst({
        where: (t, ops) =>
          ops.and(
            ops.eq(t.id, ticketId),
            ops.eq(t.condominiumId, condominiumId),
            ops.isNull(t.deletedAt),
          ),
      })
    ),
  serialize: (a: AttachmentSelect) => formatTicketAttachmentForResponse(a),
});

/**
 * Ocupante do utilizador autenticado nesta fração - o "reporter" gravado na
 * ocorrência (alvo dos emails de interação). Null quando quem cria não é
 * ocupante da fração (manager ou super a usar o portal).
 */
async function resolvePortalOccupantId(
  postgres: Postgres,
  userId: string,
  unitId: string,
): Promise<{ occupantId: string; name: string } | null> {
  const today = new Date().toISOString().slice(0, 10);
  const links = await postgres.query((db) =>
    db.query.unitOccupant.findMany({
      where: (uo, ops) =>
        ops.and(
          ops.eq(uo.unitId, unitId),
          ops.isNull(uo.deletedAt),
          ops.lte(uo.startDate, today),
          ops.or(ops.isNull(uo.endDate), ops.gte(uo.endDate, today)),
        ),
      with: { occupant: { columns: { id: true, name: true, userId: true, deletedAt: true } } },
    })
  );
  // Filtro do occupant fica em TS: Drizzle não aceita predicados em colunas de
  // relations aninhadas no `where` de topo.
  const mine = links.find((l) =>
    l.occupant && l.occupant.deletedAt === null && l.occupant.userId === userId
  );
  return mine ? { occupantId: mine.occupant.id, name: mine.occupant.name } : null;
}

// Cross-unit IDOR guard para handlers com `:ticketId` no path. Devolve
// `(cid, unitId, id, status, isVisitor)` ou 404 se o ticket não for da fração.
async function requireTicketScope(
  ctx: Context,
  postgres: Postgres,
  opts: { requireOpen?: boolean; requireMutable?: boolean; allowVisitor?: boolean } = {},
): Promise<{ cid: string; unitId: string; id: string; status: string; isVisitor: boolean }> {
  const scope = portalScope(ctx);
  const id = requireParam(ctx, "ticketId");

  // Regra portal: vê `public` ou `admin_unit` desta fração;
  // `admin_only` é sempre 404. Visitante (`allowVisitor`) só vê `public`.
  const entity = await postgres.query((db) =>
    db.query.ticket.findFirst({
      where: (t, ops) => {
        const conds = [
          ops.eq(t.id, id),
          ops.eq(t.condominiumId, scope.cid),
          ops.isNull(t.deletedAt),
        ];
        if (opts.allowVisitor) {
          conds.push(
            ops.or(
              ops.eq(t.visibility, "public"),
              ops.and(
                ops.eq(t.visibility, "admin_unit"),
                ops.eq(t.unitId, scope.unitId),
              )!,
            )!,
          );
        } else {
          // Mutate path: só admin_unit desta fração.
          conds.push(ops.eq(t.visibility, "admin_unit"));
          conds.push(ops.eq(t.unitId, scope.unitId));
        }
        return ops.and(...conds);
      },
      columns: { id: true, status: true, unitId: true },
    })
  );

  if (!entity) {
    throw new AppError({
      message: "Ocorrência não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  const isVisitor = entity.unitId !== scope.unitId;

  // Portal só muta enquanto `open`; após o admin pegar, fica imutável (evidência).
  if (opts.requireOpen && entity.status !== "open") {
    throw new AppError({
      message:
        "Ocorrência já em curso na administração. Para alterações, contacta o administrador.",
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "INVALID_STATE",
    });
  }

  // Comentar acompanha a regra do admin (`requireMutableTicket`): a conversa
  // fica aberta enquanto o assunto está vivo, congela em resolved/closed.
  if (opts.requireMutable && entity.status !== "open" && entity.status !== "in_progress") {
    throw new AppError({
      message: "Ocorrência fechada - já não permite novos comentários.",
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "INVALID_STATE",
    });
  }

  return { cid: scope.cid, unitId: scope.unitId, id, status: entity.status, isVisitor };
}

export const portalListTickets = async (ctx: Context, postgres: Postgres) => {
  const { cid: condominiumId, unitId } = portalScope(ctx);
  // Tickets da fração + públicos de zona comum (`forPortalUnit`).
  const tickets = await listTickets(postgres, condominiumId, { forPortalUnit: unitId });
  return ctx.json({ data: tickets.map((t) => formatTicketForResponse(t)) });
};

// GET tickets/:ticketId - só comments não-internal. `allowVisitor`: outras frações
// veem tickets públicos de zona comum (`isVisitor` propaga read-only ao frontend).
export const portalRetrieveTicket = async (ctx: Context, postgres: Postgres) => {
  const { cid: condominiumId, id: ticketId, isVisitor } = await requireTicketScope(
    ctx,
    postgres,
    { allowVisitor: true },
  );
  const result = await getTicketWithRelated(postgres, condominiumId, ticketId);
  if (!result) {
    throw new AppError({
      message: "Ocorrência não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  const publicComments = result.comments.filter((c) => !c.isInternal);
  return ctx.json({
    data: {
      ...formatTicketForResponse(result.ticket, publicComments, result.attachments),
      // Read-only no frontend quando true.
      isVisitor,
    },
  });
};

export const portalCreateTicket = async (ctx: Context, postgres: Postgres) => {
  const { cid: condominiumId, unitId } = portalScope(ctx);
  const actor = requireActor(ctx);

  const body = await ctx.req.json().catch(() => ({})) as {
    title?: string;
    description?: string | null;
    category?: string;
    priority?: string;
    location?: string | null;
  };

  const title = (body.title ?? "").trim();
  if (title.length < 3) {
    throw new AppError({
      message: "Título obrigatório (mínimo 3 caracteres)",
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "VALIDATION_ERROR",
    });
  }

  const reporter = await resolvePortalOccupantId(postgres, actor.user_id, unitId);

  const created = await createTicket(postgres, {
    condominiumId,
    actor,
    data: {
      title,
      description: body.description?.trim() || null,
      category: body.category ?? "other",
      priority: body.priority ?? "normal",
      unitId, // ← FIXO no path. O occupant não pode reportar para outra fração.
      location: body.location?.trim() || null,
      // Default `admin_unit`: visível ao admin e aos ocupantes desta fração.
      visibility: "admin_unit",
      reportedByOccupantId: reporter?.occupantId ?? null,
    },
  });

  // Só ocorrências nascidas no portal avisam a administração (as do painel
  // seriam eco). Best-effort: não falha a criação.
  await notifyTicketCreated(postgres, {
    ticket: created,
    reporterName: reporter?.name ?? actor.email ?? "Portal do condómino",
    panelBaseUrl: safePanelBaseUrl(ctx),
    actor,
  });

  return ctx.json({ data: formatTicketForResponse(created) }, STATUS_CODE.Created);
};

// POST tickets/:ticketId/comments - resposta do condómino. Sempre público
// (isInternal=false); visitantes de outras frações nunca chegam aqui
// (`requireTicketScope` exige admin_unit da própria fração).
export const portalAddTicketComment = async (ctx: Context, postgres: Postgres) => {
  const actor = requireActor(ctx);
  const { cid: condominiumId, unitId, id: ticketId } = await requireTicketScope(ctx, postgres, {
    requireMutable: true,
  });

  const body = await ctx.req.json().catch(() => ({})) as { comment?: string };
  const comment = (body.comment ?? "").trim();
  if (comment.length === 0 || comment.length > 5000) {
    throw new AppError({
      message: "Comentário obrigatório (máximo 5000 caracteres)",
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "VALIDATION_ERROR",
    });
  }

  await addComment(postgres, {
    condominiumId,
    ticketId,
    actor,
    comment,
    isInternal: false,
  });

  const full = await getTicketWithRelated(postgres, condominiumId, ticketId);
  if (!full) {
    throw new AppError({
      message: "Ocorrência não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  const author = await resolvePortalOccupantId(postgres, actor.user_id, unitId);
  await notifyTicketActivity(postgres, {
    ticket: full.ticket,
    authorSide: "unit",
    authorLabel: author?.name ?? actor.email ?? "Portal do condómino",
    comment,
    panelBaseUrl: safePanelBaseUrl(ctx),
    actor,
  });

  const publicComments = full.comments.filter((c) => !c.isInternal);
  return ctx.json(
    { data: formatTicketForResponse(full.ticket, publicComments, full.attachments) },
    STATUS_CODE.Created,
  );
};

// PATCH tickets/:ticketId - só campos descritivos. Status/unitId/resolutionNotes
// são reservados ao admin (silently ignored se vierem no body).
export const portalUpdateTicket = async (ctx: Context, postgres: Postgres) => {
  const actor = requireActor(ctx);
  const { cid: condominiumId, id: ticketId } = await requireTicketScope(ctx, postgres);

  const body = await ctx.req.json().catch(() => ({})) as {
    title?: string;
    description?: string | null;
    category?: string;
    priority?: string;
    location?: string | null;
  };

  const patch: Record<string, unknown> = {};
  if (body.title !== undefined) {
    const t = (body.title ?? "").trim();
    if (t.length < 3) {
      throw new AppError({
        message: "Título obrigatório (mínimo 3 caracteres)",
        statusCode: STATUS_CODE.UnprocessableEntity,
        code: "VALIDATION_ERROR",
      });
    }
    patch.title = t;
  }
  if (body.description !== undefined) {
    patch.description = body.description?.trim() || null;
  }
  if (body.category !== undefined) patch.category = body.category;
  if (body.priority !== undefined) patch.priority = body.priority;
  if (body.location !== undefined) {
    patch.location = body.location?.trim() || null;
  }

  const result = await updateTicket(postgres, {
    condominiumId,
    ticketId,
    actor,
    patch: patch as Parameters<typeof updateTicket>[1]["patch"],
  });
  if (!result) {
    throw new AppError({
      message: "Ocorrência não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  const full = await getTicketWithRelated(postgres, condominiumId, ticketId);
  const publicComments = full!.comments.filter((c) => !c.isInternal);
  return ctx.json({
    data: formatTicketForResponse(full!.ticket, publicComments, full!.attachments),
  });
};

// DELETE tickets/:ticketId - soft-delete; portal só apaga ocorrências `open`
// (após o admin pegar, fica imutável). Fetch dedicado para trazer o `status`.
export const portalDeleteTicket = async (ctx: Context, postgres: Postgres) => {
  const actor = requireActor(ctx);
  const { scope: { cid: condominiumId }, id: ticketId, entity: t } = await loadUnitOwnedEntity({
    ctx,
    paramName: "ticketId",
    entityNamePT: "Ocorrência",
    fetch: ({ cid, unitId, id }, pg) =>
      pg.query((db) =>
        db.query.ticket.findFirst({
          // Portal só apaga `admin_unit` desta fração; `public` é do admin.
          where: (t, ops) =>
            ops.and(
              ops.eq(t.id, id),
              ops.eq(t.condominiumId, cid),
              ops.eq(t.unitId, unitId),
              ops.eq(t.visibility, "admin_unit"),
              ops.isNull(t.deletedAt),
            ),
          columns: { id: true, status: true },
        })
      ),
  }, postgres);

  if (t.status !== "open") {
    throw new AppError({
      message:
        "Ocorrência só pode ser apagada enquanto estiver em estado Aberto. Contacta o administrador.",
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "INVALID_STATE",
    });
  }

  const ok = await softDeleteTicket(postgres, {
    condominiumId,
    ticketId,
    actor,
  });
  if (!ok) {
    throw new AppError({
      message: "Ocorrência não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  return new Response(null, { status: STATUS_CODE.NoContent });
};

// Attachments - `requireTicketScope` blinda contra IDOR inter-unit antes de delegar.
export const portalUploadTicketAttachment = async (ctx: Context, postgres: Postgres) => {
  // Upload de evidência só enquanto `open`.
  await requireTicketScope(ctx, postgres, { requireOpen: true });
  return portalTicketAttachmentManager.upload(ctx, postgres);
};

export const portalServeTicketAttachment = async (ctx: Context, postgres: Postgres) => {
  // Download sempre disponível (mesmo após fechar); visitante também vê.
  await requireTicketScope(ctx, postgres, { allowVisitor: true });
  return portalTicketAttachmentManager.serve(ctx, postgres);
};

export const portalDeleteTicketAttachment = async (ctx: Context, postgres: Postgres) => {
  // Remoção só enquanto `open`.
  await requireTicketScope(ctx, postgres, { requireOpen: true });
  return portalTicketAttachmentManager.delete(ctx, postgres);
};
