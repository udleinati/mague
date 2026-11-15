import { createRoute, RouteConfig, z } from "@hono/zod-openapi";
import { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";

const CondoOnlyParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
});

const ManagerUserParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  userId: z.string().openapi({ example: "u_manager" }),
});

const ManagerDoc = z.object({
  id: z.string(),
  condominiumId: z.string().openapi({ example: "MgX001" }),
  userId: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CreateManagerBodyDoc = z.object({
  userId: z.string().min(1).openapi({ example: "u_some_user" }),
});

export const listManagersDoc: RouteConfig = {
  description: "Lista administradores (managers) do condomínio.",
  method: "get",
  path: "/admin/condominiums/{cid}/managers",
  request: { params: CondoOnlyParamsDoc },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(ManagerDoc) }) } },
      description: "Lista",
    },
  },
};

export const getManagerDoc: RouteConfig = {
  description: "Obtém um manager pelo userId.",
  method: "get",
  path: "/admin/condominiums/{cid}/managers/{userId}",
  request: { params: ManagerUserParamsDoc },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: ManagerDoc }) } },
      description: "Encontrado",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrado",
    },
  },
};

export const createManagerDoc: RouteConfig = {
  description: "Adiciona um user como manager deste condomínio.",
  method: "post",
  path: "/admin/condominiums/{cid}/managers",
  request: {
    params: CondoOnlyParamsDoc,
    body: { content: { "application/json": { schema: CreateManagerBodyDoc } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: ManagerDoc }) } },
      description: "Criado",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Validação (user não existe, já é manager, etc.)",
    },
  },
};

export const deleteManagerDoc: RouteConfig = {
  description:
    "Remove o manager (soft delete da relação user↔condomínio). O user global continua a existir.",
  method: "delete",
  path: "/admin/condominiums/{cid}/managers/{userId}",
  request: { params: ManagerUserParamsDoc },
  responses: {
    204: { description: "Removido" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrado",
    },
  },
};

const routes = [
  listManagersDoc,
  getManagerDoc,
  createManagerDoc,
  deleteManagerDoc,
].map((route) =>
  createRoute({ ...route, tags: ["Administradores"], security: [{ bearerAuth: [] }] })
);

export default routes;
