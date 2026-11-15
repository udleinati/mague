import { createRoute, RouteConfig } from "@hono/zod-openapi";
import {
  CondominiumListResponseDoc,
  CondominiumParamsDoc,
  CondominiumResponseWrapperDoc,
  CreateCondominiumBodyDoc,
  UpdateCondominiumBodyDoc,
} from "$apps/docs/src/types/condominium/condominium_response_doc.ts";
import { CondominiumScopeParamsDoc, ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";

export const listCondominiumsDoc: RouteConfig = {
  description: "Lista todos os condomínios ativos",
  method: "get",
  path: "/super/condominiums",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: CondominiumListResponseDoc,
        },
      },
      description: "Lista de condomínios",
    },
  },
};

export const createCondominiumDoc: RouteConfig = {
  description: "Cria um novo condomínio",
  method: "post",
  path: "/super/condominiums",
  request: {
    body: {
      content: {
        "application/json": {
          schema: CreateCondominiumBodyDoc,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: CondominiumResponseWrapperDoc,
        },
      },
      description: "Condomínio criado",
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

export const getCondominiumDoc: RouteConfig = {
  description: "Obtém um condomínio pelo ID",
  method: "get",
  path: "/super/condominiums/{id}",
  request: {
    params: CondominiumParamsDoc,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: CondominiumResponseWrapperDoc,
        },
      },
      description: "Condomínio encontrado",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Condomínio não encontrado",
    },
  },
};

export const updateCondominiumDoc: RouteConfig = {
  description: "Atualiza um condomínio",
  method: "patch",
  path: "/super/condominiums/{id}",
  request: {
    params: CondominiumParamsDoc,
    body: {
      content: {
        "application/json": {
          schema: UpdateCondominiumBodyDoc,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: CondominiumResponseWrapperDoc,
        },
      },
      description: "Condomínio atualizado",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Condomínio não encontrado",
    },
  },
};

export const deleteCondominiumDoc: RouteConfig = {
  description: "Remove um condomínio (soft delete)",
  method: "delete",
  path: "/super/condominiums/{id}",
  request: {
    params: CondominiumParamsDoc,
  },
  responses: {
    204: {
      description: "Condomínio removido",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Condomínio não encontrado",
    },
  },
};

// Admin-scope: GET/PATCH do próprio condomínio (manager lê/edita o seu).
export const getMyCondominiumDoc: RouteConfig = {
  description: "Devolve o condomínio ativo da sessão (admin-scope).",
  method: "get",
  path: "/admin/condominiums/{cid}/condominiums/me",
  request: { params: CondominiumScopeParamsDoc },
  responses: {
    200: {
      content: { "application/json": { schema: CondominiumResponseWrapperDoc } },
      description: "Condomínio ativo",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Condomínio não encontrado",
    },
  },
};

export const updateMyCondominiumDoc: RouteConfig = {
  description: "Atualiza o condomínio ativo (admin-scope). Campos: mesma shape do PATCH super.",
  method: "patch",
  path: "/admin/condominiums/{cid}/condominiums/me",
  request: {
    params: CondominiumScopeParamsDoc,
    body: { content: { "application/json": { schema: UpdateCondominiumBodyDoc } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: CondominiumResponseWrapperDoc } },
      description: "Atualizado",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Não encontrado",
    },
  },
};

const routes = [
  listCondominiumsDoc,
  createCondominiumDoc,
  getCondominiumDoc,
  updateCondominiumDoc,
  deleteCondominiumDoc,
  getMyCondominiumDoc,
  updateMyCondominiumDoc,
].map((route) => createRoute({ ...route, tags: ["Condomínio"], security: [{ bearerAuth: [] }] }));

export default routes;
