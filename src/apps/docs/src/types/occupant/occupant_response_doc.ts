import { z } from "@hono/zod-openapi";

export const OccupantResponseDoc = z.object({
  id: z.string().openapi({ example: "pQr5sT7uV2", description: "nanoid(10)" }),
  condominiumId: z.string().openapi({ example: "MgX001" }),
  userId: z.string().nullable().openapi({
    example: "u_joao_silva",
    description: "Ligação ao user global, se existir",
  }),
  name: z.string().openapi({ example: "João Silva" }),
  email: z.string().nullable().openapi({ example: "joao@exemplo.pt" }),
  nif: z.string().nullable().openapi({ example: "123456789" }),
  phone: z.string().nullable().openapi({ example: "+351912345678" }),
  personType: z.enum(["singular", "collective"]).openapi({
    example: "singular",
    description: "Natureza jurídica: pessoa singular ou pessoa coletiva (empresa)",
  }),
  isActive: z.boolean().openapi({ example: true }),
  createdAt: z.string().openapi({ example: "2026-01-01T00:00:00Z" }),
  updatedAt: z.string().openapi({ example: "2026-01-01T00:00:00Z" }),
});

export const CreateOccupantBodyDoc = z.object({
  userId: z.string().nullable().optional().openapi({ example: "u_joao_silva" }),
  name: z.string().min(1).openapi({ example: "João Silva" }),
  email: z.string().email().nullable().optional().openapi({ example: "joao@exemplo.pt" }),
  nif: z.string().nullable().optional().openapi({ example: "123456789" }),
  phone: z.string().nullable().optional().openapi({ example: "+351912345678" }),
  personType: z.enum(["singular", "collective"]).optional().openapi({ example: "singular" }),
});

export const UpdateOccupantBodyDoc = CreateOccupantBodyDoc.partial();

export const OccupantParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  occupantId: z.string().openapi({ example: "pQr5sT7uV2" }),
});

export const OccupantListResponseDoc = z.object({
  data: z.array(OccupantResponseDoc),
});

export const OccupantResponseWrapperDoc = z.object({
  data: OccupantResponseDoc,
});

export { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";
