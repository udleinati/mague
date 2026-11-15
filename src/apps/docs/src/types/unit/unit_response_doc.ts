import { z } from "@hono/zod-openapi";

export const UnitResponseDoc = z.object({
  id: z.string().openapi({ example: "Ky8jDm2LqR", description: "nanoid(10)" }),
  condominiumId: z.string().openapi({ example: "MgX001", description: "nanoid(6)" }),
  designation: z.string().openapi({ example: "1A" }),
  unitType: z.enum(["residential", "commercial"]).openapi({ example: "residential" }),
  permillage: z.number().openapi({ example: 45.321 }),
  floor: z.string().nullable().openapi({ example: "1" }),
  door: z.string().nullable().openapi({ example: "A" }),
  block: z.string().nullable().openapi({ example: "A" }),
  identifier: z.string().nullable().openapi({
    example: "Bloco 1 1º A",
    description:
      'Label derivado (stored): "Bloco {block} {floor} {door}" ou "Bloco {block} Loja {door}" para comercial',
  }),
  description: z.string().nullable().openapi({ example: "Unidade no primeiro andar" }),
  isActive: z.boolean().openapi({ example: true }),
  createdAt: z.string().openapi({ example: "2026-01-01T00:00:00Z" }),
  updatedAt: z.string().openapi({ example: "2026-01-01T00:00:00Z" }),
});

export const CreateUnitBodyDoc = z.object({
  designation: z.string().min(1).max(50).openapi({ example: "1A" }),
  unitType: z.enum(["residential", "commercial"]).default("residential").openapi({
    example: "residential",
  }),
  permillage: z.number().positive().max(1000).openapi({ example: 45.321 }),
  floor: z.string().max(20).nullable().optional().openapi({ example: "1" }),
  door: z.string().max(20).nullable().optional().openapi({ example: "A" }),
  block: z.string().max(50).nullable().optional().openapi({ example: "A" }),
  description: z.string().max(500).nullable().optional().openapi({
    example: "Unidade no primeiro andar",
  }),
});

export const UpdateUnitBodyDoc = CreateUnitBodyDoc.partial();

export const UnitParamsDoc = z.object({
  id: z.string().openapi({ example: "MgX001", description: "ID do condomínio (nanoid 6)" }),
  unitId: z.string().openapi({ example: "Ky8jDm2LqR" }),
});

export const UnitListResponseDoc = z.object({
  data: z.array(UnitResponseDoc),
});

export const UnitResponseWrapperDoc = z.object({
  data: UnitResponseDoc,
});

export { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";
