// Handlers HTTP de tickets: thin wrappers sobre _helpers.ts.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { assertOwnership } from "$api/libs/shared/assert_ownership.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import {
  ticketCommentSchema,
  ticketCreateSchema,
  ticketUpdateSchema,
} from "$api/libs/model/ticket.ts";
import { safePanelBaseUrl } from "$api/libs/shared/panel_base_url.ts";
import { formatTicketForResponse } from "./_projection.ts";
import { TICKET_STATUS_LABELS as STATUS_LABELS } from "./_labels.ts";
import { notifyTicketActivity } from "./_notify.ts";
import {
  addComment,
  countOpenTickets,
  createTicket,
  deleteComment,
  getTicketWithRelated,
  listTickets,
  requireMutableTicket,
  softDeleteTicket,
  updateTicket,
} from "./_helpers.ts";

// Autor do lado da administração nos emails de interação.
const ADMIN_AUTHOR_LABEL = "A administração";

// ─── GET /v1/admin/c/:cid/tickets ────────────────────────────────────────────
export const listTicketsHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;

  const status = ctx.req.query("status");
  const category = ctx.req.query("category");
  const priority = ctx.req.query("priority");
  const unitId = ctx.req.query("unitId");

  const rows = await listTickets(postgres, cid, {
    status,
    category,
    priority,
    unitId,
  });
  return ctx.json({
    data: rows.map((t) => formatTicketForResponse(t)),
  });
};

// ─── GET /v1/admin/c/:cid/tickets/count ──────────────────────────────────────
export const countTicketsHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  const count = await countOpenTickets(postgres, cid);
  return ctx.json({ data: { count } });
};

// ─── GET /v1/admin/c/:cid/tickets/:ticketId ──────────────────────────────────
export const retrieveTicketHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  const id = requireParam(ctx, "ticketId");
  const result = await getTicketWithRelated(postgres, cid, id);
  if (!result) {
    throw new AppError({
      message: "Ticket não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  return ctx.json({
    data: formatTicketForResponse(result.ticket, result.comments, result.attachments),
  });
};

// ─── POST /v1/admin/c/:cid/tickets ───────────────────────────────────────────
export const createTicketHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  const actor = requireActor(ctx);
  const dto = await dtoValidator(ticketCreateSchema, await ctx.req.json());
  await assertOwnership(postgres, dto, cid, { unit: "unitId" });
  const created = await createTicket(postgres, {
    condominiumId: cid,
    actor,
    data: dto,
  });
  return ctx.json(
    { data: formatTicketForResponse(created) },
    STATUS_CODE.Created,
  );
};

// ─── PATCH /v1/admin/c/:cid/tickets/:ticketId ────────────────────────────────
export const updateTicketHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  const actor = requireActor(ctx);
  const id = requireParam(ctx, "ticketId");
  const dto = await dtoValidator(ticketUpdateSchema, await ctx.req.json());
  await assertOwnership(postgres, dto, cid, { unit: "unitId" });

  // Anti-IDOR: pathologyId tem de pertencer ao mesmo condomínio.
  if (dto.pathologyId) {
    const ownPath = await postgres.query((db) =>
      db.query.pathology.findFirst({
        where: byIdInCondo(schema.pathology, dto.pathologyId!, cid),
        columns: { id: true },
      })
    );
    if (!ownPath) {
      throw new AppError({
        message: "Patologia não pertence a este condomínio.",
        statusCode: STATUS_CODE.UnprocessableEntity,
        code: "INVALID_PATHOLOGY",
      });
    }
  }

  const result = await updateTicket(postgres, {
    condominiumId: cid,
    ticketId: id,
    actor,
    patch: dto,
  });
  if (!result) {
    throw new AppError({
      message: "Ticket não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  // Auto-comment de transição (histórico no panel). Fora de transaction com o
  // update: se este insert falhar, o utilizador re-faz manual. Não-interno: a
  // transição é visível ao condómino no portal e é o corpo do email que recebe.
  let transitionComment: string | null = null;
  if (result.statusChanged && dto.status) {
    transitionComment = `Estado alterado de "${
      STATUS_LABELS[result.oldStatus] ?? result.oldStatus
    }" para "${STATUS_LABELS[dto.status] ?? dto.status}".`;
    await addComment(postgres, {
      condominiumId: cid,
      ticketId: id,
      actor,
      comment: transitionComment,
      isInternal: false,
      statusFrom: result.oldStatus,
      statusTo: dto.status,
    });
  }
  // Re-pede completo para o cliente não ter de fazer GET separado.
  const full = await getTicketWithRelated(postgres, cid, id);
  if (transitionComment && dto.status) {
    await notifyTicketActivity(postgres, {
      ticket: full!.ticket,
      authorSide: "admin",
      authorLabel: ADMIN_AUTHOR_LABEL,
      comment: transitionComment,
      statusChange: { from: result.oldStatus, to: dto.status },
      panelBaseUrl: safePanelBaseUrl(ctx),
      actor,
    });
  }
  return ctx.json({
    data: formatTicketForResponse(full!.ticket, full!.comments, full!.attachments),
  });
};

// ─── POST /v1/admin/c/:cid/tickets/:ticketId/comments ────────────────────────
export const addCommentHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  const actor = requireActor(ctx);
  const id = requireParam(ctx, "ticketId");
  const dto = await dtoValidator(ticketCommentSchema, await ctx.req.json());
  // Conteúdo só pode ser adicionado em estados não-finais.
  await requireMutableTicket(postgres, cid, id);
  const isInternal = dto.isInternal ?? false;
  await addComment(postgres, {
    condominiumId: cid,
    ticketId: id,
    actor,
    comment: dto.comment,
    isInternal,
  });
  const full = await getTicketWithRelated(postgres, cid, id);
  if (!full) {
    throw new AppError({
      message: "Ticket não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  // Comentário interno é nota de gestão - não notifica ninguém.
  if (!isInternal) {
    await notifyTicketActivity(postgres, {
      ticket: full.ticket,
      authorSide: "admin",
      authorLabel: ADMIN_AUTHOR_LABEL,
      comment: dto.comment,
      panelBaseUrl: safePanelBaseUrl(ctx),
      actor,
    });
  }
  return ctx.json(
    {
      data: formatTicketForResponse(full.ticket, full.comments, full.attachments),
    },
    STATUS_CODE.Created,
  );
};

// ─── DELETE /v1/admin/c/:cid/tickets/:ticketId/comments/:commentId ───────────
// Hard-delete (ticket_comment não tem soft-delete - append-only por design).
export const deleteCommentHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  const ticketId = requireParam(ctx, "ticketId");
  const commentId = requireParam(ctx, "commentId");
  await requireMutableTicket(postgres, cid, ticketId);
  const ok = await deleteComment(postgres, {
    condominiumId: cid,
    ticketId,
    commentId,
  });
  if (!ok) {
    throw new AppError({
      message: "Comentário não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  return new Response(null, { status: STATUS_CODE.NoContent });
};

// ─── DELETE /v1/admin/c/:cid/tickets/:ticketId ───────────────────────────────
export const deleteTicketHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  const actor = requireActor(ctx);
  const id = requireParam(ctx, "ticketId");
  const deleted = await softDeleteTicket(postgres, {
    condominiumId: cid,
    ticketId: id,
    actor,
  });
  if (!deleted) {
    throw new AppError({
      message: "Ticket não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  return new Response(null, { status: STATUS_CODE.NoContent });
};
