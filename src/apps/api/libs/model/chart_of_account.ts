import { z } from "zod";
import { AccountTypeSchema } from "$api/libs/enums.ts";

const accountTypeEnum = AccountTypeSchema;

export const chartOfAccountCreateSchema = z.object({
  code: z.string().min(1, "Código é obrigatório").max(20),
  name: z.string().min(1, "Nome é obrigatório").max(150),
  type: accountTypeEnum,
  parentCode: z.string().max(20).nullable().optional(),
  description: z.string().nullable().optional(),
});

export const chartOfAccountUpdateSchema = z.object({
  code: z.string().min(1).max(20).optional(),
  name: z.string().min(1).max(150).optional(),
  type: accountTypeEnum.optional(),
  parentCode: z.string().max(20).nullable().optional(),
  isActive: z.boolean().optional(),
  description: z.string().nullable().optional(),
});

export type ChartOfAccountUpdate = z.infer<typeof chartOfAccountUpdateSchema>;
