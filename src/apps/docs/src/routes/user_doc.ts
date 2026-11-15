import { createRoute, RouteConfig } from "@hono/zod-openapi";
import {
  CondominiumUserParamsDoc,
  ErrorResponseDoc,
  UpdateUserBodyDoc,
  UserListResponseDoc,
  UserResponseWrapperDoc,
} from "$apps/docs/src/types/user/user_response_doc.ts";

export const listUsersDoc: RouteConfig = {
  description: "Lista todos os utilizadores de um condomínio",
  method: "get",
  path: "/admin/condominiums/{cid}/users",
  request: {
    params: CondominiumUserParamsDoc,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: UserListResponseDoc,
        },
      },
      description: "Lista de utilizadores",
    },
  },
};

export const getUserDoc: RouteConfig = {
  description: "Obtém um utilizador pelo ID",
  method: "get",
  path: "/admin/condominiums/{cid}/users/{userId}",
  request: {
    params: CondominiumUserParamsDoc,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: UserResponseWrapperDoc,
        },
      },
      description: "Utilizador encontrado",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Utilizador não encontrado",
    },
  },
};

export const updateUserDoc: RouteConfig = {
  description: "Atualiza um utilizador",
  method: "patch",
  path: "/admin/condominiums/{cid}/users/{userId}",
  request: {
    params: CondominiumUserParamsDoc,
    body: {
      content: {
        "application/json": {
          schema: UpdateUserBodyDoc,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: UserResponseWrapperDoc,
        },
      },
      description: "Utilizador atualizado",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "Utilizador não encontrado",
    },
  },
};

export const deleteUserDoc: RouteConfig = {
  description:
    "Remove o user deste condomínio (soft delete). Apaga as relações manager + unit_occupant no cid atual. O user global continua a existir.",
  method: "delete",
  path: "/admin/condominiums/{cid}/users/{userId}",
  request: {
    params: CondominiumUserParamsDoc,
  },
  responses: {
    204: { description: "Removido deste condomínio" },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseDoc,
        },
      },
      description: "User não encontrado neste condomínio",
    },
  },
};

const routes = [
  listUsersDoc,
  getUserDoc,
  updateUserDoc,
  deleteUserDoc,
].map((route) => createRoute({ ...route, tags: ["Utilizadores"], security: [{ bearerAuth: [] }] }));

export default routes;
