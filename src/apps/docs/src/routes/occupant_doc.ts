import { createRoute, RouteConfig, z } from "@hono/zod-openapi";
import {
  CreateOccupantBodyDoc,
  ErrorResponseDoc,
  OccupantListResponseDoc,
  OccupantParamsDoc,
  OccupantResponseWrapperDoc,
  UpdateOccupantBodyDoc,
} from "$apps/docs/src/types/occupant/occupant_response_doc.ts";

export const listOccupantsDoc: RouteConfig = {
  description: "Lista todos os ocupantes de um condomínio",
  method: "get",
  path: "/admin/condominiums/{cid}/occupants",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: OccupantListResponseDoc,
        },
      },
      description: "Lista de ocupantes",
    },
  },
};

export const createOccupantDoc: RouteConfig = {
  description: "Cria um novo ocupante",
  method: "post",
  path: "/admin/condominiums/{cid}/occupants",
  request: {
    body: {
      content: {
        "application/json": {
          schema: CreateOccupantBodyDoc,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: OccupantResponseWrapperDoc,
        },
      },
      description: "Ocupante criado",
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

export const getOccupantDoc: RouteConfig = {
  description: "Obtém um ocupante pelo ID",
  method: "get",
  path: "/admin/condominiums/{cid}/occupants/{occupantId}",
  request: {
    params: OccupantParamsDoc,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: OccupantResponseWrapperDoc,
        },
      },
      description: "Ocupante encontrado",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Ocupante não encontrado",
    },
  },
};

export const updateOccupantDoc: RouteConfig = {
  description: "Atualiza um ocupante",
  method: "patch",
  path: "/admin/condominiums/{cid}/occupants/{occupantId}",
  request: {
    params: OccupantParamsDoc,
    body: {
      content: {
        "application/json": {
          schema: UpdateOccupantBodyDoc,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: OccupantResponseWrapperDoc,
        },
      },
      description: "Ocupante atualizado",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Ocupante não encontrado",
    },
  },
};

export const deleteOccupantDoc: RouteConfig = {
  description: "Remove um ocupante (soft delete)",
  method: "delete",
  path: "/admin/condominiums/{cid}/occupants/{occupantId}",
  request: {
    params: OccupantParamsDoc,
  },
  responses: {
    204: {
      description: "Ocupante removido",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Ocupante não encontrado",
    },
  },
};

export const inviteByOccupantDoc: RouteConfig = {
  description: "Envia/re-envia convite ao ocupante para acesso ao portal. " +
    "Cria `core.user` se necessário, gera token de convite (24h) e envia " +
    "email com link `/accept-invite?token=…`. Re-invocar invalida tokens " +
    "anteriores e gera um novo (efeito \"re-enviar convite\"). " +
    "Pré-condição: occupant tem de ter email preenchido.",
  method: "post",
  path: "/admin/condominiums/{cid}/occupants/{occupantId}/invite",
  request: {
    params: OccupantParamsDoc,
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.object({
              userId: z.string().openapi({ description: "ID do core.user (novo ou existente)" }),
              sentTo: z.string().email().openapi({ description: "Email para o qual foi enviado" }),
              expiresAt: z.string().datetime().openapi({ description: "Validade do token" }),
            }),
          }),
        },
      },
      description: "Convite enviado",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "MISSING_EMAIL - occupant sem email preenchido",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Occupant não encontrado neste condomínio",
    },
  },
};

const routes = [
  listOccupantsDoc,
  createOccupantDoc,
  getOccupantDoc,
  updateOccupantDoc,
  deleteOccupantDoc,
  inviteByOccupantDoc,
].map((route) => createRoute({ ...route, tags: ["Ocupantes"], security: [{ bearerAuth: [] }] }));

export default routes;
