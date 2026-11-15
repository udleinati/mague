import { z } from "@hono/zod-openapi";

export const UserResponseDoc = z.object({
  id: z.string().openapi({
    example: "u_admin",
    description: 'ID do user (seeds usam prefixo "u_"; criados via API são nanoid 10)',
  }),
  email: z.string().openapi({ example: "admin@mague.pt" }),
  name: z.string().openapi({ example: "Administrador" }),
  role: z.string().openapi({ example: "admin" }),
  isActive: z.boolean().openapi({ example: true }),
  createdAt: z.string().openapi({ example: "2026-01-01T00:00:00Z" }),
  updatedAt: z.string().openapi({ example: "2026-01-01T00:00:00Z" }),
  nif: z.string().nullable().openapi({ example: "123456789" }),
  phone: z.string().nullable().openapi({ example: "+351912345678" }),
});

export const UpdateUserBodyDoc = z.object({
  name: z.string().min(1).max(255).optional().openapi({ example: "Administrador" }),
  phone: z.string().max(30).nullable().optional().openapi({ example: "+351912345678" }),
  nif: z.string().max(20).nullable().optional().openapi({ example: "123456789" }),
});

export const CondominiumUserParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  userId: z.string().openapi({ example: "u_admin" }),
});

export const UserListResponseDoc = z.object({
  data: z.array(UserResponseDoc),
});

export const UserResponseWrapperDoc = z.object({
  data: UserResponseDoc,
});

export { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";
