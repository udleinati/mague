import { createRoute, RouteConfig } from "@hono/zod-openapi";
import {
  BudgetLineListResponseDoc,
  BudgetLineParamsDoc,
  BudgetLineResponseWrapperDoc,
  CreateBudgetLineBodyDoc,
  ErrorResponseDoc,
  UpdateBudgetLineBodyDoc,
} from "$apps/docs/src/types/budget_line/budget_line_response_doc.ts";

export const listBudgetLinesDoc: RouteConfig = {
  description: "Lista todas as linhas de um orçamento",
  method: "get",
  path: "/admin/condominiums/{cid}/budgets/{budgetId}/lines",
  request: {
    params: BudgetLineParamsDoc,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: BudgetLineListResponseDoc,
        },
      },
      description: "Lista de linhas de orçamento",
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

export const createBudgetLineDoc: RouteConfig = {
  description: "Cria uma nova linha de orçamento",
  method: "post",
  path: "/admin/condominiums/{cid}/budgets/{budgetId}/lines",
  request: {
    params: BudgetLineParamsDoc,
    body: {
      content: {
        "application/json": {
          schema: CreateBudgetLineBodyDoc,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: BudgetLineResponseWrapperDoc,
        },
      },
      description: "Linha de orçamento criada",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Erro de validação",
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

export const updateBudgetLineDoc: RouteConfig = {
  description: "Atualiza uma linha de orçamento",
  method: "patch",
  path: "/admin/condominiums/{cid}/budgets/{budgetId}/lines/{lineId}",
  request: {
    params: BudgetLineParamsDoc,
    body: {
      content: {
        "application/json": {
          schema: UpdateBudgetLineBodyDoc,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: BudgetLineResponseWrapperDoc,
        },
      },
      description: "Linha de orçamento atualizada",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Linha de orçamento não encontrada",
    },
  },
};

export const deleteBudgetLineDoc: RouteConfig = {
  description: "Remove uma linha de orçamento",
  method: "delete",
  path: "/admin/condominiums/{cid}/budgets/{budgetId}/lines/{lineId}",
  request: {
    params: BudgetLineParamsDoc,
  },
  responses: {
    204: {
      description: "Linha de orçamento removida",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Linha de orçamento não encontrada",
    },
  },
};

const routes = [
  listBudgetLinesDoc,
  createBudgetLineDoc,
  updateBudgetLineDoc,
  deleteBudgetLineDoc,
].map((route) =>
  createRoute({ ...route, tags: ["Linhas de Orçamento"], security: [{ bearerAuth: [] }] })
);

export default routes;
