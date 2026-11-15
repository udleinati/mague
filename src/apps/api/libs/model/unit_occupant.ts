import { z } from "zod";
import { RelationshipTypeSchema } from "$api/libs/enums.ts";

export const unitOccupantCreateSchema = z.object({
  unitId: z.string().min(1, "unitId é obrigatório"),
  occupantId: z.string().min(1, "occupantId é obrigatório"),
  relationshipType: RelationshipTypeSchema.default("owner"),
  startDate: z.string().optional(),
});

export const unitOccupantUpdateSchema = z.object({
  relationshipType: RelationshipTypeSchema.optional(),
  startDate: z.string().optional(),
  endDate: z.string().nullable().optional(),
});

export type UnitOccupantUpdate = z.infer<typeof unitOccupantUpdateSchema>;
