import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import {
  activateHandler,
  countAlertsHandler,
  createInspectionHandler,
  deactivateHandler,
  deleteAttachmentHandler,
  deleteInspectionHandler,
  listInspectionsHandler,
  listPortalInspectionsHandler,
  retrieveInspectionHandler,
  serveAttachmentHandler,
  updateInspectionHandler,
  uploadAttachmentHandler,
} from "./handlers.ts";

export const inspectionRoutes = () => {
  const route = new Hono<ApiEnv>();
  const base = "/inspections";

  // /alerts/count e /portal têm de vir antes de /:inspectionId.
  route.get(`${base}/alerts/count`, (ctx) => countAlertsHandler(ctx, postgres));
  route.get(`${base}/portal`, (ctx) => listPortalInspectionsHandler(ctx, postgres));

  route.get(base, (ctx) => listInspectionsHandler(ctx, postgres));
  route.post(base, (ctx) => createInspectionHandler(ctx, postgres));

  route.get(`${base}/:inspectionId`, (ctx) => retrieveInspectionHandler(ctx, postgres));
  route.patch(`${base}/:inspectionId`, (ctx) => updateInspectionHandler(ctx, postgres));
  route.delete(`${base}/:inspectionId`, (ctx) => deleteInspectionHandler(ctx, postgres));

  route.post(`${base}/:inspectionId/activate`, (ctx) => activateHandler(ctx, postgres));
  route.post(`${base}/:inspectionId/deactivate`, (ctx) => deactivateHandler(ctx, postgres));

  route.post(`${base}/:inspectionId/attachments`, (ctx) => uploadAttachmentHandler(ctx, postgres));
  route.get(
    `${base}/:inspectionId/attachments/:attachmentId`,
    (ctx) => serveAttachmentHandler(ctx, postgres),
  );
  route.delete(
    `${base}/:inspectionId/attachments/:attachmentId`,
    (ctx) => deleteAttachmentHandler(ctx, postgres),
  );

  return route;
};
