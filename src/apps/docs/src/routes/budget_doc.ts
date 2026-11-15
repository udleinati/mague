import { createRoute, RouteConfig, z } from "@hono/zod-openapi";
import {
  BudgetListResponseDoc,
  BudgetParamsDoc,
  BudgetResponseWrapperDoc,
  CreateBudgetBodyDoc,
  ErrorResponseDoc,
  UpdateBudgetBodyDoc,
} from "$apps/docs/src/types/budget/budget_response_doc.ts";

export const listBudgetsDoc: RouteConfig = {
  description: "Lista todos os orçamentos de um condomínio",
  method: "get",
  path: "/admin/condominiums/{cid}/budgets",
  request: {
    params: BudgetParamsDoc,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: BudgetListResponseDoc,
        },
      },
      description: "Lista de orçamentos",
    },
  },
};

export const createBudgetDoc: RouteConfig = {
  description: "Cria um novo orçamento",
  method: "post",
  path: "/admin/condominiums/{cid}/budgets",
  request: {
    params: BudgetParamsDoc,
    body: {
      content: {
        "application/json": {
          schema: CreateBudgetBodyDoc,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: BudgetResponseWrapperDoc,
        },
      },
      description: "Orçamento criado",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Erro de validação",
    },
  },
};

export const getBudgetDoc: RouteConfig = {
  description: "Obtém um orçamento pelo ID",
  method: "get",
  path: "/admin/condominiums/{cid}/budgets/{budgetId}",
  request: {
    params: BudgetParamsDoc,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: BudgetResponseWrapperDoc,
        },
      },
      description: "Orçamento encontrado",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Orçamento não encontrado",
    },
  },
};

export const updateBudgetDoc: RouteConfig = {
  description: "Atualiza um orçamento",
  method: "patch",
  path: "/admin/condominiums/{cid}/budgets/{budgetId}",
  request: {
    params: BudgetParamsDoc,
    body: {
      content: {
        "application/json": {
          schema: UpdateBudgetBodyDoc,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: BudgetResponseWrapperDoc,
        },
      },
      description: "Orçamento atualizado",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Orçamento não encontrado",
    },
  },
};

export const deleteBudgetDoc: RouteConfig = {
  description: "Remove um orçamento (soft delete)",
  method: "delete",
  path: "/admin/condominiums/{cid}/budgets/{budgetId}",
  request: {
    params: BudgetParamsDoc,
  },
  responses: {
    204: {
      description: "Orçamento removido",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Orçamento não encontrado",
    },
  },
};

export const approveBudgetDoc: RouteConfig = {
  description: "Aprova um orçamento",
  method: "post",
  path: "/admin/condominiums/{cid}/budgets/{budgetId}/approve",
  request: {
    params: BudgetParamsDoc,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: BudgetResponseWrapperDoc,
        },
      },
      description: "Orçamento aprovado",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Orçamento sem linhas ou já aprovado",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Orçamento não encontrado",
    },
  },
};

export const generateQuotasDoc: RouteConfig = {
  description:
    "Gera as 12 quotas mensais (charges) para todas as frações, a partir do orçamento aprovado. Irreversível.",
  method: "post",
  path: "/admin/condominiums/{cid}/budgets/{budgetId}/generate_quotas",
  request: { params: BudgetParamsDoc },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.object({
              generated: z.number().openapi({ description: "12 × n_frações" }),
              budgetId: z.string(),
            }),
          }),
        },
      },
      description: "Quotas geradas",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Orçamento não aprovado ou quotas já geradas",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Orçamento não encontrado",
    },
  },
};

export const getBudgetQuotaMapDoc: RouteConfig = {
  description:
    "Devolve o mapa de quotas por fração (cálculo pro-rata pela permilagem, com split ordinário/FCR).",
  method: "get",
  path: "/admin/condominiums/{cid}/budgets/{budgetId}/quota_map",
  request: { params: BudgetParamsDoc },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.object({
              fcrPercentage: z.number(),
              totalPermillage: z.number(),
              units: z.array(z.object({
                unitId: z.string(),
                unitDesignation: z.string(),
                unitPermillage: z.string(),
                monthlyBaseCents: z.number(),
                monthlyFcrCents: z.number(),
                monthlyTotalCents: z.number(),
                annualTotalCents: z.number(),
              })),
              totals: z.object({
                monthlyBaseCents: z.number(),
                monthlyFcrCents: z.number(),
                monthlyTotalCents: z.number(),
                annualTotalCents: z.number(),
              }),
            }),
          }),
        },
      },
      description: "Mapa de quotas",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Orçamento ou frações não encontrados",
    },
  },
};

const routes = [
  listBudgetsDoc,
  createBudgetDoc,
  getBudgetDoc,
  updateBudgetDoc,
  deleteBudgetDoc,
  approveBudgetDoc,
  generateQuotasDoc,
  getBudgetQuotaMapDoc,
].map((route) => createRoute({ ...route, tags: ["Orçamentos"], security: [{ bearerAuth: [] }] }));

export default routes;
