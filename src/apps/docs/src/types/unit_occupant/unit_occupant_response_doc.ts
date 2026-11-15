import { z } from "@hono/zod-openapi";

export const UnitOccupantResponseDoc = z.object({
  id: z.string().openapi({ example: "Uo7NmP3vBc", description: "nanoid(10)" }),
  unitId: z.string().openapi({ example: "Ky8jDm2LqR" }),
  occupantId: z.string().openapi({ example: "pQr5sT7uV2" }),
  relationshipType: z.enum(["owner", "tenant", "resident"]).openapi({ example: "owner" }),
  startDate: z.string().openapi({ example: "2026-01-01" }),
  endDate: z.string().nullable().openapi({ example: null }),
  createdAt: z.string().openapi({ example: "2026-01-01T00:00:00Z" }),
});

export const CreateUnitOccupantBodyDoc = z.object({
  occupantId: z.string().min(1).openapi({ example: "pQr5sT7uV2" }),
  relationshipType: z.enum(["owner", "tenant", "resident"]).openapi({ example: "owner" }),
  startDate: z.string().optional().openapi({ example: "2026-01-01" }),
});

export const UpdateUnitOccupantBodyDoc = z.object({
  relationshipType: z.enum(["owner", "tenant", "resident"]).optional().openapi({
    example: "owner",
  }),
  startDate: z.string().optional().openapi({ example: "2026-01-01" }),
  endDate: z.string().nullable().optional().openapi({ example: "2026-12-31" }),
});

export const UnitOccupantParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  unitId: z.string().openapi({ example: "Ky8jDm2LqR" }),
  unitOccupantId: z.string().openapi({ example: "Uo7NmP3vBc" }),
});

export const UnitOccupantListResponseDoc = z.object({
  data: z.array(UnitOccupantResponseDoc),
});

export const UnitOccupantResponseWrapperDoc = z.object({
  data: UnitOccupantResponseDoc,
});

export { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";
