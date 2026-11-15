import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { listCharges } from "./list.ts";
import { getCharge } from "./retrieve.ts";
import { createCharge } from "./create.ts";
import { updateCharge } from "./update.ts";
import { cancelCharge } from "./cancel.ts";
import { setChargeBudget } from "./set_budget.ts";
import { createRefacturations } from "./create_refacturations.ts";
import { getChargeLedger } from "./ledger.ts";
import { topOpenChargesByGroup } from "./top_open_by_group.ts";
import {
  deleteChargeAttachmentHandler,
  listChargeAttachmentsHandler,
  serveChargeAttachmentHandler,
  uploadChargeAttachmentHandler,
} from "./attachments.ts";

export const chargeRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/charges";

  route.get(basePath, (ctx) => listCharges(ctx, postgres));
  // Endpoint dedicado para o modal de reconciliação - devolve top-N charges
  // em aberto por unit/supplier numa única query SQL com window function.
  route.get(`${basePath}/top_open_by_group`, (ctx) => topOpenChargesByGroup(ctx, postgres));
  route.post(basePath, (ctx) => createCharge(ctx, postgres));
  route.get(`${basePath}/:chargeId`, (ctx) => getCharge(ctx, postgres));
  route.patch(`${basePath}/:chargeId`, (ctx) => updateCharge(ctx, postgres));
  route.post(`${basePath}/:chargeId/cancel`, (ctx) => cancelCharge(ctx, postgres));
  route.patch(`${basePath}/:chargeId/budget`, (ctx) => setChargeBudget(ctx, postgres));
  route.post(`${basePath}/:chargeId/refacturations`, (ctx) => createRefacturations(ctx, postgres));
  route.get(`${basePath}/:chargeId/ledger`, (ctx) => getChargeLedger(ctx, postgres));

  // Attachments (faturas, recibos, comprovativos).
  route.get(
    `${basePath}/:chargeId/attachments`,
    (ctx) => listChargeAttachmentsHandler(ctx, postgres),
  );
  route.post(
    `${basePath}/:chargeId/attachments`,
    (ctx) => uploadChargeAttachmentHandler(ctx, postgres),
  );
  route.get(
    `${basePath}/:chargeId/attachments/:attachmentId`,
    (ctx) => serveChargeAttachmentHandler(ctx, postgres),
  );
  route.delete(
    `${basePath}/:chargeId/attachments/:attachmentId`,
    (ctx) => deleteChargeAttachmentHandler(ctx, postgres),
  );

  return route;
};
