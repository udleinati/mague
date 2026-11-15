import { createRoute, RouteConfig, z } from "@hono/zod-openapi";
import { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";

const CondoOnlyParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
});

const RecurringTemplateDoc = z.object({
  id: z.string(),
  condominiumId: z.string(),
  kind: z.enum(["payable", "receivable"]),
  description: z.string(),
  amount: z.string().openapi({ description: "Valor em euros (formato string com ponto decimal)" }),
  supplierId: z.string().nullable(),
  accountId: z.string().nullable(),
  intervalType: z.enum(["monthly", "bimonthly", "quarterly", "semiannual", "annual"]),
  dayOfMonth: z.number().int().min(1).max(28),
  startDate: z.string(),
  nextRunDate: z.string(),
  lastGeneratedAt: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CreateRecurringTemplateBodyDoc = z.object({
  kind: z.enum(["payable", "receivable"]),
  description: z.string().min(1),
  amount: z.number().positive(),
  supplierId: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  intervalType: z.enum(["monthly", "bimonthly", "quarterly", "semiannual", "annual"]),
  dayOfMonth: z.number().int().min(1).max(28),
  startDate: z.string(),
  nextRunDate: z.string(),
});

const GenerateRunBodyDoc = z.object({
  throughDate: z.string().openapi({
    example: "2026-04-30",
    description:
      "Gera até (inclusive) esta data. Só templates com nextRunDate ≤ throughDate são processados.",
  }),
});

const GenerateRunResponseDoc = z.object({
  data: z.object({
    runId: z.string(),
    processedTemplates: z.number(),
    createdCharges: z.number(),
  }),
});

export const listRecurringTemplatesDoc: RouteConfig = {
  description: "Lista templates de despesas/receitas recorrentes do condomínio.",
  method: "get",
  path: "/admin/condominiums/{cid}/recurring_templates",
  request: { params: CondoOnlyParamsDoc },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ data: z.array(RecurringTemplateDoc) }) },
      },
      description: "Lista",
    },
  },
};

export const createRecurringTemplateDoc: RouteConfig = {
  description:
    "Cria um template recorrente. Será disparado em cada `intervalType` a partir de `startDate`.",
  method: "post",
  path: "/admin/condominiums/{cid}/recurring_templates",
  request: {
    params: CondoOnlyParamsDoc,
    body: { content: { "application/json": { schema: CreateRecurringTemplateBodyDoc } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: RecurringTemplateDoc }) } },
      description: "Criado",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Validação",
    },
  },
};

export const generateRecurringDoc: RouteConfig = {
  description:
    "Dispara todos os templates com nextRunDate ≤ throughDate. Cria charges, avança nextRunDate, grava recurring_generation_run.",
  method: "post",
  path: "/admin/condominiums/{cid}/recurring_templates/generate",
  request: {
    params: CondoOnlyParamsDoc,
    body: { content: { "application/json": { schema: GenerateRunBodyDoc } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: GenerateRunResponseDoc } },
      description: "Geração concluída",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Validação",
    },
  },
};

const routes = [
  listRecurringTemplatesDoc,
  createRecurringTemplateDoc,
  generateRecurringDoc,
].map((route) =>
  createRoute({ ...route, tags: ["Despesas Recorrentes"], security: [{ bearerAuth: [] }] })
);

export default routes;
