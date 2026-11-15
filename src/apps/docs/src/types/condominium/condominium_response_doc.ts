import { z } from "@hono/zod-openapi";

export const CondominiumResponseDoc = z.object({
  id: z.string().openapi({ example: "MgX001" }),
  name: z.string().openapi({ example: "Av da Mague, X" }),
  fiscalNumber: z.string().nullable().openapi({ example: "123456789" }),
  email: z.string().nullable().openapi({ example: "geral@condominio.pt" }),
  address: z.string().nullable().openapi({ example: "Rua das Flores, 100" }),
  city: z.string().nullable().openapi({ example: "Lisboa" }),
  postalCode: z.string().nullable().openapi({ example: "1000-100" }),
  quotaDayOfMonth: z.number().openapi({ example: 1 }),
  isActive: z.boolean().openapi({ example: true }),
  createdAt: z.string().openapi({ example: "2026-01-01T00:00:00Z" }),
  updatedAt: z.string().openapi({ example: "2026-01-01T00:00:00Z" }),
});

export const CreateCondominiumBodyDoc = z.object({
  name: z.string().min(1).max(100).openapi({ example: "Av da Mague, X" }),
  fiscalNumber: z.string().regex(/^\d{9}$/).nullable().optional().openapi({
    example: "123456789",
    description: "NIF/NIPC (9 dígitos)",
  }),
  email: z.string().email().max(255).nullable().optional().openapi({
    example: "geral@condominio.pt",
  }),
  address: z.string().max(200).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  postalCode: z.string().regex(/^\d{4}-\d{3}$/).nullable().optional().openapi({
    example: "1000-100",
  }),
  quotaDayOfMonth: z.number().int().min(1).max(31).default(1),
});

export const UpdateCondominiumBodyDoc = CreateCondominiumBodyDoc.partial();

export const CondominiumParamsDoc = z.object({
  id: z.string().openapi({ example: "MgX001", description: "ID do condomínio (nanoid 6)" }),
});

export const CondominiumListResponseDoc = z.object({
  data: z.array(CondominiumResponseDoc),
});

export const CondominiumResponseWrapperDoc = z.object({
  data: CondominiumResponseDoc,
});

// ErrorResponseDoc agora vive em _common.ts; re-exportamos para não quebrar imports existentes.
export { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";
