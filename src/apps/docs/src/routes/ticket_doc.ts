// Documentação OpenAPI dos endpoints de ocorrências (`core.ticket`).
// Categorias e prioridades fixas (CHECK constraint na BD); status varia
// entre open/in_progress/resolved/closed.

import { createRoute, RouteConfig, z } from "@hono/zod-openapi";
import { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";

const CondoOnlyParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
});

const TicketParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  ticketId: z.string().openapi({ example: "Tk7zXp2Q3a", description: "nanoid(10)" }),
});

const TICKET_CATEGORIES = [
  "elevator",
  "lighting",
  "plumbing",
  "hvac",
  "common_area",
  "facade",
  "parking",
  "garden",
  "security",
  "other",
] as const;
const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;

const TicketCommentDoc = z.object({
  id: z.string(),
  ticketId: z.string(),
  comment: z.string(),
  isInternal: z.boolean(),
  createdBy: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});

const TicketAttachmentDoc = z.object({
  id: z.string(),
  ticketId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  fileSize: z.number().int(),
  createdAt: z.string(),
  createdBy: z.record(z.string(), z.unknown()).nullable(),
});

const TicketDoc = z.object({
  id: z.string(),
  code: z.string().openapi({
    description: "Identificador humano per-condomínio (ex.: T001). ADR 0023.",
  }),
  condominiumId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(TICKET_PRIORITIES),
  status: z.enum(TICKET_STATUSES),
  unitId: z.string().nullable(),
  location: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  resolutionNotes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Inflated nas chamadas de retrieve.
  comments: z.array(TicketCommentDoc).optional(),
  attachments: z.array(TicketAttachmentDoc).optional(),
});

const CreateTicketBodyDoc = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(TICKET_PRIORITIES).optional().openapi({ description: "Default 'normal'." }),
  unitId: z.string().nullable().optional(),
  location: z.string().max(200).nullable().optional(),
});

const UpdateTicketBodyDoc = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  status: z.enum(TICKET_STATUSES).optional(),
  unitId: z.string().nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  resolutionNotes: z.string().max(5000).nullable().optional(),
});

const CreateCommentBodyDoc = z.object({
  comment: z.string().min(1).max(5000),
  isInternal: z.boolean().optional().openapi({
    description:
      "Se true, comentário só visível ao admin. Se false/omisso, partilhado com condóminos.",
  }),
});

export const listTicketsDoc: RouteConfig = {
  description:
    "Lista ocorrências do condomínio. Filtros opcionais: status, category, " +
    "priority, unitId. Sem paginação por defeito (ordens-de-trabalho ativas " +
    "são poucas; histórico antigo deve usar arquivamento).",
  method: "get",
  path: "/admin/condominiums/{cid}/tickets",
  request: {
    params: CondoOnlyParamsDoc,
    query: z.object({
      status: z.enum(TICKET_STATUSES).optional(),
      category: z.enum(TICKET_CATEGORIES).optional(),
      priority: z.enum(TICKET_PRIORITIES).optional(),
      unitId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(TicketDoc) }) } },
      description: "Lista",
    },
  },
};

export const countTicketsDoc: RouteConfig = {
  description:
    "Devolve a contagem de ocorrências em aberto (status IN ('open','in_progress')). " +
    "Usado pela navegação do panel para badge de alertas.",
  method: "get",
  path: "/admin/condominiums/{cid}/tickets/count",
  request: { params: CondoOnlyParamsDoc },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.object({ count: z.number() }) }) } },
      description: "Contagem",
    },
  },
};

export const createTicketDoc: RouteConfig = {
  description:
    "Cria uma nova ocorrência. `code` (T001…) é gerado automaticamente " +
    "pelo trigger antes do INSERT (sequência per-condomínio, ADR 0023).",
  method: "post",
  path: "/admin/condominiums/{cid}/tickets",
  request: {
    params: CondoOnlyParamsDoc,
    body: { content: { "application/json": { schema: CreateTicketBodyDoc } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: TicketDoc }) } },
      description: "Criada",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Validação",
    },
  },
};

export const getTicketDoc: RouteConfig = {
  description: "Obtém ocorrência pelo ID. Inclui comentários e anexos.",
  method: "get",
  path: "/admin/condominiums/{cid}/tickets/{ticketId}",
  request: { params: TicketParamsDoc },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: TicketDoc }) } },
      description: "Encontrada",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrada",
    },
  },
};

export const updateTicketDoc: RouteConfig = {
  description:
    "Atualiza ocorrência. Mudar status para 'resolved' grava `resolved_at`. " +
    "Cada mudança de status grava um auto-comment para histórico.",
  method: "patch",
  path: "/admin/condominiums/{cid}/tickets/{ticketId}",
  request: {
    params: TicketParamsDoc,
    body: { content: { "application/json": { schema: UpdateTicketBodyDoc } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: TicketDoc }) } },
      description: "Atualizada",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Validação",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrada",
    },
  },
};

export const deleteTicketDoc: RouteConfig = {
  description: "Soft-delete da ocorrência (marca `deleted_at`).",
  method: "delete",
  path: "/admin/condominiums/{cid}/tickets/{ticketId}",
  request: { params: TicketParamsDoc },
  responses: {
    204: { description: "Removida" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrada",
    },
  },
};

export const addTicketCommentDoc: RouteConfig = {
  description: "Adiciona um comentário à ocorrência (interno ou partilhado).",
  method: "post",
  path: "/admin/condominiums/{cid}/tickets/{ticketId}/comments",
  request: {
    params: TicketParamsDoc,
    body: { content: { "application/json": { schema: CreateCommentBodyDoc } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: TicketCommentDoc }) } },
      description: "Comentário criado",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Validação",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Ticket não encontrado",
    },
  },
};

const routes = [
  listTicketsDoc,
  countTicketsDoc,
  createTicketDoc,
  getTicketDoc,
  updateTicketDoc,
  deleteTicketDoc,
  addTicketCommentDoc,
].map((route) => createRoute({ ...route, tags: ["Ocorrências"], security: [{ bearerAuth: [] }] }));

export default routes;
