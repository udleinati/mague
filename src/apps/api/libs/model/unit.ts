import { z } from "zod";
import { UnitTypeSchema } from "$api/libs/enums.ts";

export const unitCreateSchema = z.object({
  designation: z.string().min(1, "Designação é obrigatória").max(50),
  unitType: UnitTypeSchema.default("residential"),
  permillage: z.number().positive("Permilagem deve ser > 0").max(1000, "Permilagem máxima é 1000"),
  floor: z.string().max(20).nullable().optional(),
  door: z.string().max(20).nullable().optional(),
  block: z.string().max(50).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
});

export const unitUpdateSchema = z.object({
  designation: z.string().min(1).max(50).optional(),
  unitType: UnitTypeSchema.optional(),
  permillage: z.number().positive().max(1000).optional(),
  floor: z.string().max(20).nullable().optional(),
  door: z.string().max(20).nullable().optional(),
  block: z.string().max(50).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
});

export type UnitUpdate = z.infer<typeof unitUpdateSchema>;
