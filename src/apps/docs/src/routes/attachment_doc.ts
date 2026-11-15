// OpenAPI dos attachments - modelo polimórfico (`core.attachment`) para
// charges/tickets/inspections/assemblies (mesma resposta, só muda o path).
// Portal (read-only) só expõe `assemblies/{id}/attachments` e o serve.

import { createRoute, RouteConfig, z } from "@hono/zod-openapi";
import { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";

// ── Schemas partilhados ────────────────────────────────────────────────────
// Campos comuns; cada definição concreta abaixo expõe o alias retro de
// `entityId` (`chargeId`/`ticketId`/`inspectionId`/`assemblyId`).
const AttachmentBaseDoc = z.object({
  id: z.string().openapi({ example: "At7yZxQ9p2", description: "nanoid(10)" }),
  filename: z.string().openapi({ example: "fatura-2026-03.pdf" }),
  mimeType: z.string().openapi({ example: "application/pdf" }),
  fileSize: z.number().int().openapi({ description: "Tamanho em bytes" }),
  createdAt: z.string().openapi({ example: "2026-03-15T12:34:56Z" }),
  createdBy: z.record(z.string(), z.unknown()).nullable().openapi({
    description: "Actor JSONB {id, email, ip, request_id}",
  }),
});

const ChargeAttachmentDoc = AttachmentBaseDoc.extend({
  chargeId: z.string().openapi({ description: "Alias retro de entity_id" }),
});
const TicketAttachmentDoc = AttachmentBaseDoc.extend({
  ticketId: z.string(),
});
const InspectionAttachmentDoc = AttachmentBaseDoc.extend({
  inspectionId: z.string(),
});
const AssemblyAttachmentDoc = AttachmentBaseDoc.extend({
  assemblyId: z.string(),
});

const UploadBodyDoc = z.object({
  file: z.instanceof(File).openapi({
    type: "string",
    format: "binary",
    description:
      "Ficheiro a anexar (PDF/imagem/genérico). Limite ~20MB. " +
      "Validado server-side (MIME + tamanho).",
  }),
});

// ── Charges ────────────────────────────────────────────────────────────────
const ChargeAttParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  chargeId: z.string().openapi({ example: "Ch4Rg5eAbC" }),
});
const ChargeAttDetailParamsDoc = ChargeAttParamsDoc.extend({
  attachmentId: z.string().openapi({ example: "At7yZxQ9p2" }),
});

export const listChargeAttachmentsDoc: RouteConfig = {
  description: "Lista todos os anexos não-eliminados de uma charge.",
  method: "get",
  path: "/admin/condominiums/{cid}/charges/{chargeId}/attachments",
  request: { params: ChargeAttParamsDoc },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ data: z.array(ChargeAttachmentDoc) }) },
      },
      description: "Lista de anexos",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Charge não encontrada",
    },
  },
};

export const uploadChargeAttachmentDoc: RouteConfig = {
  description:
    "Faz upload de um ficheiro associado a uma charge (fatura/recibo/comprovativo). " +
    "Usa multipart/form-data com campo `file`. Grava em S3 com path " +
    "`<cid>/charge/<shard>/<chargeId>/<attachmentId>-<filename>`.",
  method: "post",
  path: "/admin/condominiums/{cid}/charges/{chargeId}/attachments",
  request: {
    params: ChargeAttParamsDoc,
    body: { content: { "multipart/form-data": { schema: UploadBodyDoc } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: ChargeAttachmentDoc }) } },
      description: "Anexo criado",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Ficheiro inválido (campo em falta, tamanho excedido, MIME bloqueado)",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Charge não encontrada",
    },
  },
};

export const serveChargeAttachmentDoc: RouteConfig = {
  description:
    "Serve os bytes de um anexo (Content-Type vem do `mime_type` gravado). " +
    "Usar `<img>`/`<iframe src>` ou redirect a partir do panel.",
  method: "get",
  path: "/admin/condominiums/{cid}/charges/{chargeId}/attachments/{attachmentId}",
  request: { params: ChargeAttDetailParamsDoc },
  responses: {
    200: {
      content: { "application/octet-stream": {} },
      description: "Bytes do ficheiro",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Anexo não encontrado",
    },
  },
};

export const deleteChargeAttachmentDoc: RouteConfig = {
  description:
    "Soft-delete do anexo + remoção do objeto S3. Idempotente: chamar 2× " +
    "devolve 404 na 2ª chamada (já não existe).",
  method: "delete",
  path: "/admin/condominiums/{cid}/charges/{chargeId}/attachments/{attachmentId}",
  request: { params: ChargeAttDetailParamsDoc },
  responses: {
    204: { description: "Removido" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Anexo não encontrado",
    },
  },
};

// ── Tickets ────────────────────────────────────────────────────────────────
const TicketAttParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  ticketId: z.string().openapi({ example: "Tk7zXp2Q3a" }),
});
const TicketAttDetailParamsDoc = TicketAttParamsDoc.extend({
  attachmentId: z.string().openapi({ example: "At7yZxQ9p2" }),
});

export const uploadTicketAttachmentDoc: RouteConfig = {
  description:
    "Faz upload de um ficheiro associado a uma ocorrência (foto, PDF de orçamento, etc.).",
  method: "post",
  path: "/admin/condominiums/{cid}/tickets/{ticketId}/attachments",
  request: {
    params: TicketAttParamsDoc,
    body: { content: { "multipart/form-data": { schema: UploadBodyDoc } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: TicketAttachmentDoc }) } },
      description: "Anexo criado",
    },
    400: { content: { "application/json": { schema: ErrorResponseDoc } }, description: "Inválido" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Ticket não encontrado",
    },
  },
};

export const serveTicketAttachmentDoc: RouteConfig = {
  description: "Serve os bytes de um anexo de ocorrência.",
  method: "get",
  path: "/admin/condominiums/{cid}/tickets/{ticketId}/attachments/{attachmentId}",
  request: { params: TicketAttDetailParamsDoc },
  responses: {
    200: { content: { "application/octet-stream": {} }, description: "Bytes" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrado",
    },
  },
};

export const deleteTicketAttachmentDoc: RouteConfig = {
  description: "Soft-delete + remoção S3 do anexo da ocorrência.",
  method: "delete",
  path: "/admin/condominiums/{cid}/tickets/{ticketId}/attachments/{attachmentId}",
  request: { params: TicketAttDetailParamsDoc },
  responses: {
    204: { description: "Removido" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrado",
    },
  },
};

// ── Inspections ────────────────────────────────────────────────────────────
const InspectionAttParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  inspectionId: z.string().openapi({ example: "Ip7yZxQ9p2" }),
});
const InspectionAttDetailParamsDoc = InspectionAttParamsDoc.extend({
  attachmentId: z.string().openapi({ example: "At7yZxQ9p2" }),
});

export const uploadInspectionAttachmentDoc: RouteConfig = {
  description:
    "Faz upload de um certificado/PDF associado a uma inspeção (extintor, " +
    "elevador, gás, etc.).",
  method: "post",
  path: "/admin/condominiums/{cid}/inspections/{inspectionId}/attachments",
  request: {
    params: InspectionAttParamsDoc,
    body: { content: { "multipart/form-data": { schema: UploadBodyDoc } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: InspectionAttachmentDoc }) } },
      description: "Anexo criado",
    },
    400: { content: { "application/json": { schema: ErrorResponseDoc } }, description: "Inválido" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Inspeção não encontrada",
    },
  },
};

export const serveInspectionAttachmentDoc: RouteConfig = {
  description: "Serve os bytes de um anexo de inspeção.",
  method: "get",
  path: "/admin/condominiums/{cid}/inspections/{inspectionId}/attachments/{attachmentId}",
  request: { params: InspectionAttDetailParamsDoc },
  responses: {
    200: { content: { "application/octet-stream": {} }, description: "Bytes" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrado",
    },
  },
};

export const deleteInspectionAttachmentDoc: RouteConfig = {
  description: "Soft-delete + remoção S3 do anexo da inspeção.",
  method: "delete",
  path: "/admin/condominiums/{cid}/inspections/{inspectionId}/attachments/{attachmentId}",
  request: { params: InspectionAttDetailParamsDoc },
  responses: {
    204: { description: "Removido" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrado",
    },
  },
};

// ── Assemblies (admin) ─────────────────────────────────────────────────────
const AssemblyAttParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  assemblyId: z.string().openapi({ example: "As5EmB1yZx" }),
});
const AssemblyAttDetailParamsDoc = AssemblyAttParamsDoc.extend({
  attachmentId: z.string().openapi({ example: "At7yZxQ9p2" }),
});

export const listAssemblyAttachmentsDoc: RouteConfig = {
  description: "Lista anexos de uma assembleia (ata PDF, presenças, anexos pontuais).",
  method: "get",
  path: "/admin/condominiums/{cid}/assemblies/{assemblyId}/attachments",
  request: { params: AssemblyAttParamsDoc },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ data: z.array(AssemblyAttachmentDoc) }) },
      },
      description: "Lista",
    },
  },
};

export const uploadAssemblyAttachmentDoc: RouteConfig = {
  description: "Faz upload de um anexo da assembleia.",
  method: "post",
  path: "/admin/condominiums/{cid}/assemblies/{assemblyId}/attachments",
  request: {
    params: AssemblyAttParamsDoc,
    body: { content: { "multipart/form-data": { schema: UploadBodyDoc } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: AssemblyAttachmentDoc }) } },
      description: "Criado",
    },
    400: { content: { "application/json": { schema: ErrorResponseDoc } }, description: "Inválido" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Assembleia não encontrada",
    },
  },
};

export const serveAssemblyAttachmentDoc: RouteConfig = {
  description: "Serve bytes do anexo da assembleia (admin).",
  method: "get",
  path: "/admin/condominiums/{cid}/assemblies/{assemblyId}/attachments/{attachmentId}",
  request: { params: AssemblyAttDetailParamsDoc },
  responses: {
    200: { content: { "application/octet-stream": {} }, description: "Bytes" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrado",
    },
  },
};

export const deleteAssemblyAttachmentDoc: RouteConfig = {
  description: "Soft-delete + remoção S3 do anexo da assembleia.",
  method: "delete",
  path: "/admin/condominiums/{cid}/assemblies/{assemblyId}/attachments/{attachmentId}",
  request: { params: AssemblyAttDetailParamsDoc },
  responses: {
    204: { description: "Removido" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrado",
    },
  },
};

// ── Portal (read-only): só assembleias têm anexos visíveis ao condómino ───
const PortalAssemblyAttParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  assemblyId: z.string().openapi({ example: "As5EmB1yZx" }),
});
const PortalAssemblyAttDetailParamsDoc = PortalAssemblyAttParamsDoc.extend({
  attachmentId: z.string().openapi({ example: "At7yZxQ9p2" }),
});

export const portalListAssemblyAttachmentsDoc: RouteConfig = {
  description:
    "Portal - lista anexos de uma assembleia já realizada (status=held). " +
    "Read-only: nem upload nem delete. Anti-IDOR: occupant tem que ser " +
    "ocupante de fração do condomínio.",
  method: "get",
  path: "/portal/condominiums/{cid}/assemblies/{assemblyId}/attachments",
  request: { params: PortalAssemblyAttParamsDoc },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ data: z.array(AssemblyAttachmentDoc) }) },
      },
      description: "Lista de anexos visíveis ao condómino",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Sem acesso a este condomínio",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Assembleia não encontrada",
    },
  },
};

export const portalServeAssemblyAttachmentDoc: RouteConfig = {
  description: "Portal - serve bytes do anexo da assembleia (read-only).",
  method: "get",
  path: "/portal/condominiums/{cid}/assemblies/{assemblyId}/attachments/{attachmentId}",
  request: { params: PortalAssemblyAttDetailParamsDoc },
  responses: {
    200: { content: { "application/octet-stream": {} }, description: "Bytes" },
    403: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Sem acesso",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrado",
    },
  },
};

const adminAttachmentRoutes = [
  listChargeAttachmentsDoc,
  uploadChargeAttachmentDoc,
  serveChargeAttachmentDoc,
  deleteChargeAttachmentDoc,
  uploadTicketAttachmentDoc,
  serveTicketAttachmentDoc,
  deleteTicketAttachmentDoc,
  uploadInspectionAttachmentDoc,
  serveInspectionAttachmentDoc,
  deleteInspectionAttachmentDoc,
  listAssemblyAttachmentsDoc,
  uploadAssemblyAttachmentDoc,
  serveAssemblyAttachmentDoc,
  deleteAssemblyAttachmentDoc,
].map((route) => createRoute({ ...route, tags: ["Anexos"], security: [{ bearerAuth: [] }] }));

const portalAttachmentRoutes = [
  portalListAssemblyAttachmentsDoc,
  portalServeAssemblyAttachmentDoc,
].map((route) =>
  createRoute({ ...route, tags: ["Anexos (Portal)"], security: [{ bearerAuth: [] }] })
);

const routes = [...adminAttachmentRoutes, ...portalAttachmentRoutes];
export default routes;
