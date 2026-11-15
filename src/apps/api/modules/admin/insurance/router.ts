import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { requireUnitInCondo } from "$api/middleware/require_unit_in_condo.ts";
import {
  approvePolicyHandler,
  createUnitPolicyHandler,
  deletePolicyHandler,
  editPolicyHandler,
  listPoliciesHandler,
  listUnitsStatusHandler,
  previewReminderHandler,
  rejectPolicyHandler,
  renewPolicyHandler,
  reopenPolicyHandler,
  retrievePolicyHandler,
  sendBulkRemindersHandler,
  sendReminderHandler,
  serveInsuranceAttachmentHandler,
  servePolicyPdfHandler,
  undoRenewalHandler,
} from "./handlers.ts";

export const insuranceRoutes = () => {
  const route = new Hono<ApiEnv>();
  const base = "/insurance";

  // /units-status precisa vir antes de /:policyId.
  route.get(`${base}/units-status`, (ctx) => listUnitsStatusHandler(ctx, postgres));
  route.get(base, (ctx) => listPoliciesHandler(ctx, postgres));
  route.get(`${base}/:policyId`, (ctx) => retrievePolicyHandler(ctx, postgres));
  route.get(`${base}/:policyId/pdf`, (ctx) => servePolicyPdfHandler(ctx, postgres));
  route.get(
    `${base}/:policyId/attachments/:attachmentId`,
    (ctx) => serveInsuranceAttachmentHandler(ctx, postgres),
  );
  route.delete(`${base}/:policyId`, (ctx) => deletePolicyHandler(ctx, postgres));

  // Criar de raiz pendura-se na fração (não há policyId de onde partir); o
  // `requireUnitInCondo` é o gate anti-IDOR de `:unitId` (404 cross-tenant).
  route.post(
    "/units/:unitId/insurance",
    requireUnitInCondo(),
    (ctx) => createUnitPolicyHandler(ctx, postgres),
  );

  // Confirm não existe no admin (ADR 0016 - o comprovativo vem da fração).
  // Edit é PATCH (consolida os antigos /auto-renew + /coverage-amount num
  // único endpoint partial). Renew é o caminho da admin-action manual: JSON
  // vazio para a presumida, multipart quando o documento chegou à administração.
  route.patch(`${base}/:policyId`, (ctx) => editPolicyHandler(ctx, postgres));
  route.post(`${base}/:policyId/approve`, (ctx) => approvePolicyHandler(ctx, postgres));
  route.post(`${base}/:policyId/reject`, (ctx) => rejectPolicyHandler(ctx, postgres));
  route.post(`${base}/:policyId/renew`, (ctx) => renewPolicyHandler(ctx, postgres));
  route.post(`${base}/:policyId/undo-renewal`, (ctx) => undoRenewalHandler(ctx, postgres));
  route.post(`${base}/:policyId/reopen`, (ctx) => reopenPolicyHandler(ctx, postgres));

  // Reminders: bulk (path raiz) ou single (path com unitId). Preview = GET
  // read-only do email de uma fração (com a nota gravada), sem enviar.
  route.get(
    `${base}/reminders/:unitId/preview`,
    requireUnitInCondo(),
    (ctx) => previewReminderHandler(ctx, postgres),
  );
  route.post(`${base}/reminders`, (ctx) => sendBulkRemindersHandler(ctx, postgres));
  route.post(
    `${base}/reminders/:unitId`,
    requireUnitInCondo(),
    (ctx) => sendReminderHandler(ctx, postgres),
  );

  return route;
};
