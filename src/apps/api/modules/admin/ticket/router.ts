import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import {
  addCommentHandler,
  countTicketsHandler,
  createTicketHandler,
  deleteCommentHandler,
  deleteTicketHandler,
  listTicketsHandler,
  retrieveTicketHandler,
  updateTicketHandler,
} from "./handlers.ts";
import {
  deleteTicketAttachmentHandler,
  serveTicketAttachmentHandler,
  uploadTicketAttachmentHandler,
} from "./attachments.ts";

export const ticketRoutes = () => {
  const route = new Hono<ApiEnv>();
  const base = "/tickets";

  // /tickets/count tem que vir ANTES do /:ticketId para não ser apanhado
  // como `:ticketId = "count"` (Hono casa o primeiro match).
  route.get(`${base}/count`, (ctx) => countTicketsHandler(ctx, postgres));
  route.get(base, (ctx) => listTicketsHandler(ctx, postgres));
  route.post(base, (ctx) => createTicketHandler(ctx, postgres));
  route.get(`${base}/:ticketId`, (ctx) => retrieveTicketHandler(ctx, postgres));
  route.patch(`${base}/:ticketId`, (ctx) => updateTicketHandler(ctx, postgres));
  route.delete(`${base}/:ticketId`, (ctx) => deleteTicketHandler(ctx, postgres));
  route.post(`${base}/:ticketId/comments`, (ctx) => addCommentHandler(ctx, postgres));
  route.delete(
    `${base}/:ticketId/comments/:commentId`,
    (ctx) => deleteCommentHandler(ctx, postgres),
  );

  // Attachments (fotos/PDFs).
  route.post(
    `${base}/:ticketId/attachments`,
    (ctx) => uploadTicketAttachmentHandler(ctx, postgres),
  );
  route.get(
    `${base}/:ticketId/attachments/:attachmentId`,
    (ctx) => serveTicketAttachmentHandler(ctx, postgres),
  );
  route.delete(
    `${base}/:ticketId/attachments/:attachmentId`,
    (ctx) => deleteTicketAttachmentHandler(ctx, postgres),
  );

  return route;
};
