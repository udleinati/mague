import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { listDocuments } from "./list.ts";
import { getDocument } from "./retrieve.ts";
import { createDocument } from "./create.ts";
import { updateDocument } from "./update.ts";
import { deleteDocument } from "./delete.ts";
import {
  deleteDocumentAttachmentHandler,
  serveDocumentAttachmentHandler,
  uploadDocumentAttachmentHandler,
} from "./attachments.ts";

export const documentRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/documents";

  route.get(basePath, (ctx) => listDocuments(ctx, postgres));
  route.get(`${basePath}/:documentId`, (ctx) => getDocument(ctx, postgres));
  route.post(basePath, (ctx) => createDocument(ctx, postgres));
  route.patch(`${basePath}/:documentId`, (ctx) => updateDocument(ctx, postgres));
  route.delete(`${basePath}/:documentId`, (ctx) => deleteDocument(ctx, postgres));

  // Attachments (PDF/imagem) - upload/serve/delete.
  route.post(
    `${basePath}/:documentId/attachments`,
    (ctx) => uploadDocumentAttachmentHandler(ctx, postgres),
  );
  route.get(
    `${basePath}/:documentId/attachments/:attachmentId`,
    (ctx) => serveDocumentAttachmentHandler(ctx, postgres),
  );
  route.delete(
    `${basePath}/:documentId/attachments/:attachmentId`,
    (ctx) => deleteDocumentAttachmentHandler(ctx, postgres),
  );

  return route;
};
