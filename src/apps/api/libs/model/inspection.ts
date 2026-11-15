import { z } from "zod";
import { INSPECTION_CATEGORIES } from "$api/libs/postgres/schemas/inspection.ts";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const inspectionCreateSchema = z.object({
  category: z.enum(INSPECTION_CATEGORIES),
  description: z.string().min(1, "Descrição é obrigatória").max(500),
  validUntil: z.string().regex(dateRegex, "Data deve ser YYYY-MM-DD"),
  lastDoneDate: z.string().regex(dateRegex).nullable().optional(),
  notifyDaysBefore: z.number().int().min(0).max(365).optional(),
  notes: z.string().max(2000).nullable().optional(),
  supplierId: z.string().nullable().optional(),
});

export const inspectionUpdateSchema = z.object({
  category: z.enum(INSPECTION_CATEGORIES).optional(),
  description: z.string().min(1).max(500).optional(),
  validUntil: z.string().regex(dateRegex).optional(),
  lastDoneDate: z.string().regex(dateRegex).nullable().optional(),
  notifyDaysBefore: z.number().int().min(0).max(365).optional(),
  notes: z.string().max(2000).nullable().optional(),
  supplierId: z.string().nullable().optional(),
});
