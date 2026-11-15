import { createRoute, RouteConfig, z } from "@hono/zod-openapi";
import { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";

const LoginBodyDoc = z.object({
  email: z.string().email().openapi({ example: "admin@mague.pt" }),
  password: z.string().min(1).openapi({ example: "senha-forte-123" }),
});

const AuthSessionResponseDoc = z.object({
  data: z.object({
    token: z.string().openapi({
      example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
      description: "JWT HS256 a usar em Authorization: Bearer",
    }),
    expiresAt: z.string().openapi({ example: "2026-05-22T13:32:11.827Z" }),
    user: z.object({
      id: z.string().openapi({ example: "u_super" }),
      email: z.string().openapi({ example: "super@mague.pt" }),
      name: z.string().openapi({ example: "Super Admin" }),
      role: z.string().openapi({ example: "super" }),
    }),
  }),
});

const AuthMeResponseDoc = z.object({
  data: z.object({
    user: z.object({
      id: z.string(),
      email: z.string(),
      name: z.string(),
      role: z.string(),
    }),
    managedCondominiumIds: z.array(z.string()).openapi({ example: ["MgX001"] }),
  }),
});

const ChangePasswordBodyDoc = z.object({
  currentPassword: z.string().min(1).openapi({ example: "senha-atual" }),
  newPassword: z.string().min(8).openapi({ example: "nova-senha-forte-1" }),
});

export const loginDoc: RouteConfig = {
  description:
    "Autentica um utilizador com email+password e cria uma sessão. Devolve o JWT a usar em Authorization: Bearer.",
  method: "post",
  path: "/auth/login",
  request: {
    body: { content: { "application/json": { schema: LoginBodyDoc } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: AuthSessionResponseDoc } },
      description: "Sessão criada",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Validação falhou (email ou password em falta)",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Credenciais inválidas",
    },
  },
};

export const meDoc: RouteConfig = {
  description: "Devolve o utilizador da sessão atual + lista de condomínios geridos.",
  method: "get",
  path: "/auth/me",
  responses: {
    200: {
      content: { "application/json": { schema: AuthMeResponseDoc } },
      description: "Utilizador da sessão",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Sessão em falta ou inválida",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Utilizador não encontrado",
    },
  },
};

export const logoutDoc: RouteConfig = {
  description: "Revoga a sessão atual em Valkey. Requer Authorization: Bearer.",
  method: "post",
  path: "/auth/logout",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.object({ loggedOut: z.boolean() }) }),
        },
      },
      description: "Logout processado",
    },
  },
};

export const changePasswordDoc: RouteConfig = {
  description:
    "Altera a senha do utilizador atual. Valida a senha antiga, exige nova com ≥8 caracteres e diferente da atual.",
  method: "post",
  path: "/auth/change-password",
  request: {
    body: { content: { "application/json": { schema: ChangePasswordBodyDoc } } },
  },
  responses: {
    204: { description: "Senha alterada" },
    400: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Validação falhou (senha curta, igual, campos em falta)",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseDoc } },
      description: "Sessão inválida ou senha atual incorreta",
    },
  },
};

const routes = [loginDoc, meDoc, logoutDoc, changePasswordDoc].map((route) =>
  createRoute({ ...route, tags: ["Autenticação"], security: [{ bearerAuth: [] }] })
);

export default routes;
