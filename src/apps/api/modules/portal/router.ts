// Router /v1/portal/condominiums/:cid/... - dados das frações para occupants
// (portal SSR). Read-only, exceto `track_access` de recibos. Auth: `apiAuth`
// antes, depois `requirePortalAccessToCondo` (nível condo) ou
// `requirePortalAccessToUnit` (`:unitId` específico).

import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import {
  requirePortalAccessToCondo,
  requirePortalAccessToUnit,
} from "$api/middleware/require_portal_access.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";

import { portalGetCondominium } from "./condominium.ts";
import { portalGetUnit } from "./unit.ts";
import { portalListCharges } from "./charge.ts";
import { portalListSettlements } from "./settlement.ts";
import {
  portalGetReceipt,
  portalListReceipts,
  portalServeReceiptPdf,
  portalTrackReceiptAccess,
} from "./receipt.ts";
import {
  portalAddTicketComment,
  portalCreateTicket,
  portalDeleteTicket,
  portalDeleteTicketAttachment,
  portalListTickets,
  portalRetrieveTicket,
  portalServeTicketAttachment,
  portalUpdateTicket,
  portalUploadTicketAttachment,
} from "./ticket.ts";
import {
  portalAddInsuranceAttachment,
  portalConfirmInsurance,
  portalDeleteInsurance,
  portalDeleteInsuranceAttachment,
  portalGetInsurance,
  portalGetInsuranceStatus,
  portalListInsurance,
  portalListInsuranceAttachments,
  portalRenewInsurance,
  portalServeInsuranceAttachment,
  portalServeInsurancePdf,
  portalUploadInsurance,
} from "./insurance.ts";
import { saveOccupantNif } from "./save_occupant_nif.ts";
import { saveOccupantProfile } from "./save_occupant_profile.ts";
import { saveReceiveReceipts } from "./save_receive_receipts.ts";
import { portalListDocuments } from "./document.ts";
import { portalServeDocumentAttachmentHandler } from "./document_attachments.ts";
import { portalGetPathology, portalListPathologies } from "./pathology.ts";
import { portalServePathologyAttachmentHandler } from "./pathology_attachments.ts";
import {
  portalGetAssembly,
  portalGetBudget,
  portalGetBudgetQuotaMap,
  portalListAssemblies,
  portalListBankAccounts,
  portalListBudgets,
  portalListInspections,
} from "./wrappers.ts";
import {
  portalListAssemblyAttachmentsHandler,
  portalServeAssemblyAttachmentHandler,
} from "./assembly_attachments.ts";

const portalRoutes = new Hono<ApiEnv>();

// ── Nível condomínio ────────────────────────────────────────────────────
portalRoutes.use("/condominiums/:cid", requirePortalAccessToCondo());
portalRoutes.use("/condominiums/:cid/assemblies/*", requirePortalAccessToCondo());
portalRoutes.use("/condominiums/:cid/budgets/*", requirePortalAccessToCondo());
portalRoutes.use("/condominiums/:cid/bank_accounts", requirePortalAccessToCondo());
portalRoutes.use("/condominiums/:cid/inspections", requirePortalAccessToCondo());
portalRoutes.use("/condominiums/:cid/documents", requirePortalAccessToCondo());
portalRoutes.use("/condominiums/:cid/documents/*", requirePortalAccessToCondo());
portalRoutes.use("/condominiums/:cid/pathologies", requirePortalAccessToCondo());
portalRoutes.use("/condominiums/:cid/pathologies/*", requirePortalAccessToCondo());

portalRoutes.get("/condominiums/:cid", (c) => portalGetCondominium(c, postgres));

portalRoutes.get("/condominiums/:cid/assemblies", (c) => portalListAssemblies(c, postgres));
portalRoutes.get(
  "/condominiums/:cid/assemblies/:assemblyId",
  (c) => portalGetAssembly(c, postgres),
);
portalRoutes.get(
  "/condominiums/:cid/assemblies/:assemblyId/attachments",
  (c) => portalListAssemblyAttachmentsHandler(c, postgres),
);
portalRoutes.get(
  "/condominiums/:cid/assemblies/:assemblyId/attachments/:attachmentId",
  (c) => portalServeAssemblyAttachmentHandler(c, postgres),
);

portalRoutes.get("/condominiums/:cid/budgets", (c) => portalListBudgets(c, postgres));
portalRoutes.get("/condominiums/:cid/budgets/:budgetId", (c) => portalGetBudget(c, postgres));
portalRoutes.get(
  "/condominiums/:cid/budgets/:budgetId/quota_map",
  (c) => portalGetBudgetQuotaMap(c, postgres),
);

portalRoutes.get("/condominiums/:cid/bank_accounts", (c) => portalListBankAccounts(c, postgres));

portalRoutes.get("/condominiums/:cid/inspections", (c) => portalListInspections(c, postgres));

// ── Nível unidade (`:unitId` no path - middleware mais apertado) ────────
portalRoutes.use("/condominiums/:cid/units/:unitId/*", requirePortalAccessToUnit());
portalRoutes.use("/condominiums/:cid/units/:unitId", requirePortalAccessToUnit());

portalRoutes.get("/condominiums/:cid/units/:unitId", (c) => portalGetUnit(c, postgres));

portalRoutes.get("/condominiums/:cid/units/:unitId/charges", (c) => portalListCharges(c, postgres));

portalRoutes.get(
  "/condominiums/:cid/units/:unitId/settlements",
  (c) => portalListSettlements(c, postgres),
);

portalRoutes.get(
  "/condominiums/:cid/units/:unitId/receipts",
  (c) => portalListReceipts(c, postgres),
);
portalRoutes.get(
  "/condominiums/:cid/units/:unitId/receipts/:receiptId",
  (c) => portalGetReceipt(c, postgres),
);
portalRoutes.get(
  "/condominiums/:cid/units/:unitId/receipts/:receiptId/pdf",
  (c) => portalServeReceiptPdf(c, postgres),
);
// track_access: occupantId derivado do user logado, não do body (anti-IDOR).
portalRoutes.post(
  "/condominiums/:cid/units/:unitId/receipts/:receiptId/track_access",
  (c) => portalTrackReceiptAccess(c, postgres),
);

// Tickets - condómino gere as ocorrências da sua fração. Status/resolução
// fica reservado ao admin (PATCH portal ignora esses campos); só comments públicos.
portalRoutes.get(
  "/condominiums/:cid/units/:unitId/tickets",
  (c) => portalListTickets(c, postgres),
);
portalRoutes.post(
  "/condominiums/:cid/units/:unitId/tickets",
  (c) => portalCreateTicket(c, postgres),
);
portalRoutes.get(
  "/condominiums/:cid/units/:unitId/tickets/:ticketId",
  (c) => portalRetrieveTicket(c, postgres),
);
portalRoutes.patch(
  "/condominiums/:cid/units/:unitId/tickets/:ticketId",
  (c) => portalUpdateTicket(c, postgres),
);
portalRoutes.delete(
  "/condominiums/:cid/units/:unitId/tickets/:ticketId",
  (c) => portalDeleteTicket(c, postgres),
);
portalRoutes.post(
  "/condominiums/:cid/units/:unitId/tickets/:ticketId/comments",
  (c) => portalAddTicketComment(c, postgres),
);
portalRoutes.post(
  "/condominiums/:cid/units/:unitId/tickets/:ticketId/attachments",
  (c) => portalUploadTicketAttachment(c, postgres),
);
portalRoutes.get(
  "/condominiums/:cid/units/:unitId/tickets/:ticketId/attachments/:attachmentId",
  (c) => portalServeTicketAttachment(c, postgres),
);
portalRoutes.delete(
  "/condominiums/:cid/units/:unitId/tickets/:ticketId/attachments/:attachmentId",
  (c) => portalDeleteTicketAttachment(c, postgres),
);

// Insurance - condómino vê/submete/confirma apólice da sua fração. Não tem
// approve/reject (esse fluxo fica no admin).
portalRoutes.get(
  "/condominiums/:cid/units/:unitId/insurance",
  (c) => portalListInsurance(c, postgres),
);
// Antes de `/:policyId` - senão "status" seria lido como um id de apólice.
portalRoutes.get(
  "/condominiums/:cid/units/:unitId/insurance/status",
  (c) => portalGetInsuranceStatus(c, postgres),
);
portalRoutes.get(
  "/condominiums/:cid/units/:unitId/insurance/:policyId",
  (c) => portalGetInsurance(c, postgres),
);
portalRoutes.get(
  "/condominiums/:cid/units/:unitId/insurance/:policyId/pdf",
  (c) => portalServeInsurancePdf(c, postgres),
);
portalRoutes.post(
  "/condominiums/:cid/units/:unitId/insurance",
  (c) => portalUploadInsurance(c, postgres),
);
portalRoutes.get(
  "/condominiums/:cid/units/:unitId/insurance/:policyId/attachments",
  (c) => portalListInsuranceAttachments(c, postgres),
);
portalRoutes.post(
  "/condominiums/:cid/units/:unitId/insurance/:policyId/attachments",
  (c) => portalAddInsuranceAttachment(c, postgres),
);
portalRoutes.get(
  "/condominiums/:cid/units/:unitId/insurance/:policyId/attachments/:attachmentId",
  (c) => portalServeInsuranceAttachment(c, postgres),
);
portalRoutes.delete(
  "/condominiums/:cid/units/:unitId/insurance/:policyId/attachments/:attachmentId",
  (c) => portalDeleteInsuranceAttachment(c, postgres),
);
portalRoutes.post(
  "/condominiums/:cid/units/:unitId/insurance/:policyId/confirm",
  (c) => portalConfirmInsurance(c, postgres),
);
portalRoutes.post(
  "/condominiums/:cid/units/:unitId/insurance/:policyId/renew",
  (c) => portalRenewInsurance(c, postgres),
);
portalRoutes.delete(
  "/condominiums/:cid/units/:unitId/insurance/:policyId",
  (c) => portalDeleteInsurance(c, postgres),
);

// Save NIF do occupant. Migrou de /auth/me/nif (em core.user) para per-occupant.
portalRoutes.post(
  "/condominiums/:cid/units/:unitId/save-nif",
  (c) => saveOccupantNif(c, postgres),
);
// Self-update do perfil do occupant. NIF tem fluxo dedicado acima (write-once).
portalRoutes.post(
  "/condominiums/:cid/units/:unitId/save-occupant-profile",
  (c) => saveOccupantProfile(c, postgres),
);
// Toggle inline de "receber recibos por email" - só 1 campo (não exige name/email/phone).
portalRoutes.post(
  "/condominiums/:cid/units/:unitId/save-receive-receipts",
  (c) => saveReceiveReceipts(c, postgres),
);

// Documentos públicos (read-only, só is_public=true): lista + descarrega anexos.
portalRoutes.get("/condominiums/:cid/documents", (c) => portalListDocuments(c, postgres));
portalRoutes.get(
  "/condominiums/:cid/documents/:documentId/attachments/:attachmentId",
  (c) => portalServeDocumentAttachmentHandler(c, postgres),
);

// Patologias públicas do edifício (ADR 0024: status != 'draft'). Read-only.
// Padrão ADR 0003: scope=public no _query partilhado com admin + ownershipQuery
// no manager de anexos. Sem `tickets[]` no detalhe (anti cross-fração leak).
portalRoutes.get("/condominiums/:cid/pathologies", (c) => portalListPathologies(c, postgres));
portalRoutes.get(
  "/condominiums/:cid/pathologies/:pathologyId",
  (c) => portalGetPathology(c, postgres),
);
portalRoutes.get(
  "/condominiums/:cid/pathologies/:pathologyId/attachments/:attachmentId",
  (c) => portalServePathologyAttachmentHandler(c, postgres),
);

export default portalRoutes;
