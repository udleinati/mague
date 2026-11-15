import { createRoute, RouteConfig, z } from "@hono/zod-openapi";
import { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";

const CondoOnlyParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
});

const SupplierParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  supplierId: z.string().openapi({ example: "S1pPl3r2Wx", description: "nanoid(10)" }),
});

const SupplierDoc = z.object({
  id: z.string(),
  condominiumId: z.string(),
  name: z.string(),
  nif: z.string().nullable().openapi({ example: "123456789" }),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  iban: z.string().nullable(),
  notes: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CreateSupplierBodyDoc = z.object({
  name: z.string().min(1).max(255),
  nif: z.string().max(20).nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  iban: z.string().max(34).nullable().optional(),
  notes: z.string().nullable().optional(),
});

const UpdateSupplierBodyDoc = CreateSupplierBodyDoc.partial().extend({
  isActive: z.boolean().optional(),
});

export const listSuppliersDoc: RouteConfig = {
  description: "Lista fornecedores do condomínio.",
  method: "get",
  path: "/admin/condominiums/{cid}/suppliers",
  request: { params: CondoOnlyParamsDoc },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(SupplierDoc) }) } },
      description: "Lista",
    },
  },
};

export const createSupplierDoc: RouteConfig = {
  description: "Cria um novo fornecedor.",
  method: "post",
  path: "/admin/condominiums/{cid}/suppliers",
  request: {
    params: CondoOnlyParamsDoc,
    body: { content: { "application/json": { schema: CreateSupplierBodyDoc } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: SupplierDoc }) } },
      description: "Criado",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Validação",
    },
  },
};

export const getSupplierDoc: RouteConfig = {
  description: "Obtém um fornecedor pelo ID.",
  method: "get",
  path: "/admin/condominiums/{cid}/suppliers/{supplierId}",
  request: { params: SupplierParamsDoc },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: SupplierDoc }) } },
      description: "Encontrado",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrado",
    },
  },
};

export const updateSupplierDoc: RouteConfig = {
  description: "Atualiza um fornecedor.",
  method: "patch",
  path: "/admin/condominiums/{cid}/suppliers/{supplierId}",
  request: {
    params: SupplierParamsDoc,
    body: { content: { "application/json": { schema: UpdateSupplierBodyDoc } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: SupplierDoc }) } },
      description: "Atualizado",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrado",
    },
  },
};

export const deleteSupplierDoc: RouteConfig = {
  description: "Remove um fornecedor (soft delete).",
  method: "delete",
  path: "/admin/condominiums/{cid}/suppliers/{supplierId}",
  request: { params: SupplierParamsDoc },
  responses: {
    204: { description: "Removido" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrado",
    },
  },
};

const routes = [
  listSuppliersDoc,
  createSupplierDoc,
  getSupplierDoc,
  updateSupplierDoc,
  deleteSupplierDoc,
].map((route) => createRoute({ ...route, tags: ["Fornecedores"], security: [{ bearerAuth: [] }] }));

export default routes;
