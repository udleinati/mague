import { createRoute, RouteConfig } from "@hono/zod-openapi";
import {
  CategoryParamsDoc,
  ChartOfAccountListResponseDoc,
  ChartOfAccountResponseWrapperDoc,
  CreateChartOfAccountBodyDoc,
  ErrorResponseDoc,
  UpdateChartOfAccountBodyDoc,
} from "$apps/docs/src/types/chart_of_account/chart_of_account_response_doc.ts";

export const listExpenseCategoriesDoc: RouteConfig = {
  description: "Lista todas as categorias de despesa de um condomínio",
  method: "get",
  path: "/admin/condominiums/{cid}/chart_of_accounts",
  request: {
    params: CategoryParamsDoc,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ChartOfAccountListResponseDoc,
        },
      },
      description: "Lista de categorias de despesa",
    },
  },
};

export const createChartOfAccountDoc: RouteConfig = {
  description: "Cria uma nova categoria de despesa",
  method: "post",
  path: "/admin/condominiums/{cid}/chart_of_accounts",
  request: {
    params: CategoryParamsDoc,
    body: {
      content: {
        "application/json": {
          schema: CreateChartOfAccountBodyDoc,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: ChartOfAccountResponseWrapperDoc,
        },
      },
      description: "Categoria de despesa criada",
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

export const getChartOfAccountDoc: RouteConfig = {
  description: "Obtém uma categoria de despesa pelo ID",
  method: "get",
  path: "/admin/condominiums/{cid}/chart_of_accounts/{accountId}",
  request: {
    params: CategoryParamsDoc,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ChartOfAccountResponseWrapperDoc,
        },
      },
      description: "Categoria de despesa encontrada",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Categoria de despesa não encontrada",
    },
  },
};

export const updateChartOfAccountDoc: RouteConfig = {
  description: "Atualiza uma categoria de despesa",
  method: "patch",
  path: "/admin/condominiums/{cid}/chart_of_accounts/{accountId}",
  request: {
    params: CategoryParamsDoc,
    body: {
      content: {
        "application/json": {
          schema: UpdateChartOfAccountBodyDoc,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ChartOfAccountResponseWrapperDoc,
        },
      },
      description: "Categoria de despesa atualizada",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Categoria de despesa não encontrada",
    },
  },
};

export const deleteChartOfAccountDoc: RouteConfig = {
  description: "Remove uma categoria de despesa (soft delete)",
  method: "delete",
  path: "/admin/condominiums/{cid}/chart_of_accounts/{accountId}",
  request: {
    params: CategoryParamsDoc,
  },
  responses: {
    204: {
      description: "Categoria de despesa removida",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Categoria de despesa não encontrada",
    },
  },
};

const routes = [
  listExpenseCategoriesDoc,
  createChartOfAccountDoc,
  getChartOfAccountDoc,
  updateChartOfAccountDoc,
  deleteChartOfAccountDoc,
].map((route) =>
  createRoute({ ...route, tags: ["Categorias de Despesa"], security: [{ bearerAuth: [] }] })
);

export default routes;
