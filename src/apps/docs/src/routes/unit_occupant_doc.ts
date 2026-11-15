import { createRoute, RouteConfig, z } from "@hono/zod-openapi";
import {
  CreateUnitOccupantBodyDoc,
  ErrorResponseDoc,
  UnitOccupantListResponseDoc,
  UnitOccupantParamsDoc,
  UnitOccupantResponseWrapperDoc,
  UpdateUnitOccupantBodyDoc,
} from "$apps/docs/src/types/unit_occupant/unit_occupant_response_doc.ts";

export const listUnitOccupantsDoc: RouteConfig = {
  description: "Lista todos os ocupantes de uma fração",
  method: "get",
  path: "/admin/condominiums/{cid}/units/{unitId}/occupants",
  request: {
    params: UnitOccupantParamsDoc,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: UnitOccupantListResponseDoc,
        },
      },
      description: "Lista de ocupantes da fração",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Fração não encontrada",
    },
  },
};

export const createUnitOccupantDoc: RouteConfig = {
  description: "Adiciona um ocupante a uma fração",
  method: "post",
  path: "/admin/condominiums/{cid}/units/{unitId}/occupants",
  request: {
    params: UnitOccupantParamsDoc,
    body: {
      content: {
        "application/json": {
          schema: CreateUnitOccupantBodyDoc,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: UnitOccupantResponseWrapperDoc,
        },
      },
      description: "Ocupante adicionado",
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
      description: "Fração não encontrada",
    },
  },
};

export const getUnitOccupantDoc: RouteConfig = {
  description: "Obtém um ocupante pelo ID",
  method: "get",
  path: "/admin/condominiums/{cid}/units/{unitId}/occupants/{unitOccupantId}",
  request: {
    params: UnitOccupantParamsDoc,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: UnitOccupantResponseWrapperDoc,
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

export const updateUnitOccupantDoc: RouteConfig = {
  description: "Atualiza um ocupante",
  method: "patch",
  path: "/admin/condominiums/{cid}/units/{unitId}/occupants/{unitOccupantId}",
  request: {
    params: UnitOccupantParamsDoc,
    body: {
      content: {
        "application/json": {
          schema: UpdateUnitOccupantBodyDoc,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: UnitOccupantResponseWrapperDoc,
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

export const deleteUnitOccupantDoc: RouteConfig = {
  description: "Remove um ocupante (soft delete)",
  method: "delete",
  path: "/admin/condominiums/{cid}/units/{unitId}/occupants/{unitOccupantId}",
  request: {
    params: UnitOccupantParamsDoc,
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

export const deleteUnitOccupantByOccupantDoc: RouteConfig = {
  description:
    "Remove a relação unit↔occupant através do occupantId (conveniência, não precisa do unit_occupant.id).",
  method: "delete",
  path: "/admin/condominiums/{cid}/units/{unitId}/occupants/by-occupant/{occupantId}",
  request: {
    params: z.object({
      cid: z.string().openapi({ example: "MgX001" }),
      unitId: z.string(),
      occupantId: z.string(),
    }),
  },
  responses: {
    204: { description: "Removido" },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Relação não encontrada",
    },
  },
};

const routes = [
  listUnitOccupantsDoc,
  createUnitOccupantDoc,
  getUnitOccupantDoc,
  updateUnitOccupantDoc,
  deleteUnitOccupantDoc,
  deleteUnitOccupantByOccupantDoc,
].map((route) =>
  createRoute({ ...route, tags: ["Ocupantes de Fração"], security: [{ bearerAuth: [] }] })
);

export default routes;
