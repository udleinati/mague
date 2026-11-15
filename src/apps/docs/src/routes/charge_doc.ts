import { createRoute, RouteConfig, z } from "@hono/zod-openapi";
import { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";

const CondoOnlyParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
});

const ChargeParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  chargeId: z.string().openapi({ example: "Ch4Rg5eAbC", description: "nanoid(10)" }),
});

const ChargeDoc = z.object({
  id: z.string(),
  condominiumId: z.string(),
  kind: z.enum(["receivable", "payable"]),
  nature: z.enum(["debit", "credit"]),
  chargeType: z.string().openapi({ example: "quota" }),
  description: z.string(),
  issueDate: z.string(),
  dueDate: z.string().nullable(),
  competencePeriod: z.string().nullable(),
  originalAmount: z.number().openapi({ description: "Valor original em cêntimos" }),
  settledAmount: z.number(),
  openAmount: z.number(),
  status: z.enum(["open", "partial", "overdue", "closed", "cancelled"]),
  unitId: z.string().nullable(),
  supplierId: z.string().nullable(),
  accountId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CreateChargeBodyDoc = z.object({
  kind: z.enum(["receivable", "payable"]),
  chargeType: z.string(),
  description: z.string().min(1),
  issueDate: z.string(),
  dueDate: z.string().nullable().optional(),
  competencePeriod: z.string().nullable().optional(),
  amountCents: z.number().int(),
  unitId: z.string().nullable().optional(),
  supplierId: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
});

const CreateRefacturationsBodyDoc = z.object({
  distribution: z.enum(["permillage", "equal", "custom"]).openapi({
    description: "Critério de repartição por frações",
  }),
  lines: z.array(z.object({
    unitId: z.string(),
    amountCents: z.number().int(),
  })).optional().openapi({ description: "Obrigatório se distribution=custom" }),
});

const PaginationDoc = z.object({
  page: z.number().int(),
  perPage: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

export const listChargesDoc: RouteConfig = {
  description:
    "Lista charges do condomínio. Filtros: kind, unitId, supplierId, status. " +
    "Paginação opcional via `page` + `perPage` (default perPage=500, cap 1000). " +
    "Sem `page`, devolve até `limit` rows (default 500, cap 1000).",
  method: "get",
  path: "/admin/condominiums/{cid}/charges",
  request: {
    params: CondoOnlyParamsDoc,
    query: z.object({
      kind: z.enum(["receivable", "payable"]).optional(),
      unitId: z.string().optional(),
      supplierId: z.string().optional(),
      status: z.string().optional(),
      limit: z.string().optional().openapi({ example: "500" }),
      page: z.string().optional().openapi({ example: "1" }),
      perPage: z.string().optional().openapi({ example: "500" }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(ChargeDoc),
            pagination: PaginationDoc.optional().openapi({
              description: "Presente apenas quando `page` é passado.",
            }),
          }),
        },
      },
      description: "Lista",
    },
  },
};

export const createChargeDoc: RouteConfig = {
  description: "Cria uma charge (receita a receber ou despesa a pagar).",
  method: "post",
  path: "/admin/condominiums/{cid}/charges",
  request: {
    params: CondoOnlyParamsDoc,
    body: { content: { "application/json": { schema: CreateChargeBodyDoc } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: ChargeDoc }) } },
      description: "Criada",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Validação",
    },
  },
};

export const getChargeDoc: RouteConfig = {
  description: "Obtém uma charge pelo ID.",
  method: "get",
  path: "/admin/condominiums/{cid}/charges/{chargeId}",
  request: { params: ChargeParamsDoc },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: ChargeDoc }) } },
      description: "Encontrada",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrada",
    },
  },
};

export const createRefacturationsDoc: RouteConfig = {
  description:
    "Gera refacturations a partir de uma despesa do condomínio (divide por frações segundo o critério indicado).",
  method: "post",
  path: "/admin/condominiums/{cid}/charges/{chargeId}/refacturations",
  request: {
    params: ChargeParamsDoc,
    body: { content: { "application/json": { schema: CreateRefacturationsBodyDoc } } },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.object({ created: z.number(), charges: z.array(ChargeDoc) }),
          }),
        },
      },
      description: "Refacturations criadas",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Validação",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Charge não encontrada",
    },
  },
};

const routes = [
  listChargesDoc,
  createChargeDoc,
  getChargeDoc,
  createRefacturationsDoc,
].map((route) => createRoute({ ...route, tags: ["Charges"], security: [{ bearerAuth: [] }] }));

export default routes;
