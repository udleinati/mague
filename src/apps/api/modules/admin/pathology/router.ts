import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { listPathologies } from "./list.ts";
import { getPathology } from "./retrieve.ts";
import { createPathology } from "./create.ts";
import { updatePathology } from "./update.ts";
import { deletePathology } from "./delete.ts";
import {
  deletePathologyAttachmentHandler,
  servePathologyAttachmentHandler,
  uploadPathologyAttachmentHandler,
} from "./attachments.ts";
import { copyAttachmentsFromTicket } from "./copy_from_ticket.ts";

export const pathologyRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/pathologies";

  route.get(basePath, (ctx) => listPathologies(ctx, postgres));
  route.get(`${basePath}/:pathologyId`, (ctx) => getPathology(ctx, postgres));
  route.post(basePath, (ctx) => createPathology(ctx, postgres));
  route.patch(`${basePath}/:pathologyId`, (ctx) => updatePathology(ctx, postgres));
  route.delete(`${basePath}/:pathologyId`, (ctx) => deletePathology(ctx, postgres));

  // Attachments (fotos/PDFs).
  route.post(
    `${basePath}/:pathologyId/attachments`,
    (ctx) => uploadPathologyAttachmentHandler(ctx, postgres),
  );
  route.get(
    `${basePath}/:pathologyId/attachments/:attachmentId`,
    (ctx) => servePathologyAttachmentHandler(ctx, postgres),
  );
  route.delete(
    `${basePath}/:pathologyId/attachments/:attachmentId`,
    (ctx) => deletePathologyAttachmentHandler(ctx, postgres),
  );

  // Server-side: duplica os attachments de um ticket nesta patologia.
  // Usado pelo "promover ticket a patologia" no painel.
  route.post(
    `${basePath}/:pathologyId/copy-attachments-from-ticket`,
    (ctx) => copyAttachmentsFromTicket(ctx, postgres),
  );

  return route;
};
