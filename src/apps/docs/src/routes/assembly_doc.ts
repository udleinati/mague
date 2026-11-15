import { createRoute, RouteConfig, z } from "@hono/zod-openapi";
import { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";

const AssemblyParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  assemblyId: z.string().openapi({ example: "As5EmB1yZx", description: "nanoid(10)" }),
});

const CondoOnlyParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
});

const AssemblyDoc = z.object({
  id: z.string(),
  condominiumId: z.string(),
  type: z.enum(["ordinary", "extraordinary"]).openapi({ example: "ordinary" }),
  status: z.enum(["scheduled", "held", "cancelled"]).openapi({ example: "scheduled" }),
  scheduledAt: z.string().openapi({ example: "2026-05-15" }),
  location: z.string().nullable(),
  minutesNumber: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CreateAssemblyBodyDoc = z.object({
  type: z.enum(["ordinary", "extraordinary"]),
  scheduledAt: z.string().openapi({ example: "2026-05-15" }),
  location: z.string().nullable().optional(),
  minutesNumber: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const UpdateAssemblyBodyDoc = CreateAssemblyBodyDoc.partial().extend({
  status: z.enum(["scheduled", "held", "cancelled"]).optional(),
  heldAt: z.string().nullable().optional(),
});

const CreateAssemblyAgendaItemBodyDoc = z.object({
  sequence: z.number().int().min(1),
  subject: z.string().min(1),
  description: z.string().nullable().optional(),
  itemType: z.string().nullable().optional(),
  refType: z.string().nullable().optional(),
  refId: z.string().nullable().optional(),
  approved: z.boolean(),
  votesInFavor: z.number().nullable().optional(),
  votesAgainst: z.number().nullable().optional(),
  votesAbstain: z.number().nullable().optional(),
});

export const listAssembliesDoc: RouteConfig = {
  description: "Lista todas as assembleias do condomínio.",
  method: "get",
  path: "/admin/condominiums/{cid}/assemblies",
  request: { params: CondoOnlyParamsDoc },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(AssemblyDoc) }) } },
      description: "Lista",
    },
  },
};

export const createAssemblyDoc: RouteConfig = {
  description: "Cria uma nova assembleia (status inicial: scheduled).",
  method: "post",
  path: "/admin/condominiums/{cid}/assemblies",
  request: {
    params: CondoOnlyParamsDoc,
    body: { content: { "application/json": { schema: CreateAssemblyBodyDoc } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: AssemblyDoc }) } },
      description: "Criada",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Validação",
    },
  },
};

export const getAssemblyDoc: RouteConfig = {
  description: "Obtém uma assembleia pelo ID (inclui deliberações).",
  method: "get",
  path: "/admin/condominiums/{cid}/assemblies/{assemblyId}",
  request: { params: AssemblyParamsDoc },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: AssemblyDoc }) } },
      description: "Encontrada",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrada",
    },
  },
};

export const updateAssemblyDoc: RouteConfig = {
  description: "Atualiza assembleia (incluindo mudar status para held/cancelled).",
  method: "patch",
  path: "/admin/condominiums/{cid}/assemblies/{assemblyId}",
  request: {
    params: AssemblyParamsDoc,
    body: { content: { "application/json": { schema: UpdateAssemblyBodyDoc } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: AssemblyDoc }) } },
      description: "Atualizada",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrada",
    },
  },
};

export const deleteAssemblyDoc: RouteConfig = {
  description: "Remove uma assembleia (soft delete).",
  method: "delete",
  path: "/admin/condominiums/{cid}/assemblies/{assemblyId}",
  request: { params: AssemblyParamsDoc },
  responses: {
    204: { description: "Removida" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrada",
    },
  },
};

export const createAssemblyAgendaItemDoc: RouteConfig = {
  description: "Adiciona uma deliberação à assembleia.",
  method: "post",
  path: "/admin/condominiums/{cid}/assemblies/{assemblyId}/agenda-items",
  request: {
    params: AssemblyParamsDoc,
    body: { content: { "application/json": { schema: CreateAssemblyAgendaItemBodyDoc } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: z.any() }) } },
      description: "Deliberação criada",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Validação",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Assembleia não encontrada",
    },
  },
};

const routes = [
  listAssembliesDoc,
  createAssemblyDoc,
  getAssemblyDoc,
  updateAssemblyDoc,
  deleteAssemblyDoc,
  createAssemblyAgendaItemDoc,
].map((route) => createRoute({ ...route, tags: ["Assembleias"], security: [{ bearerAuth: [] }] }));

export default routes;
