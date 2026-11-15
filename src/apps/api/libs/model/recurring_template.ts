import { z } from "zod";
import {
  IntervalTypeSchema,
  RecurringKindSchema,
  RecurringPaymentMethodSchema,
} from "$api/libs/enums.ts";

const kindEnum = RecurringKindSchema;
const intervalEnum = IntervalTypeSchema;

export const recurringTemplateCreateSchema = z.object({
  kind: kindEnum,
  description: z.string().min(1).max(255),
  amount: z.number().int().positive(),
  accountId: z.string().nullable().optional(),
  supplierId: z.string().nullable().optional(),
  contractId: z.string().nullable().optional(),
  unitId: z.string().nullable().optional(),
  intervalType: intervalEnum,
  paymentMethod: RecurringPaymentMethodSchema.optional(),
  dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
  startDate: z.string().date(),
  endDate: z.string().date().nullable().optional(),
  nextRunDate: z.string().date(),
  notes: z.string().nullable().optional(),
});

export const recurringTemplateUpdateSchema = z.object({
  description: z.string().min(1).max(255).optional(),
  amount: z.number().int().positive().optional(),
  accountId: z.string().nullable().optional(),
  supplierId: z.string().nullable().optional(),
  contractId: z.string().nullable().optional(),
  intervalType: intervalEnum.optional(),
  paymentMethod: RecurringPaymentMethodSchema.optional(),
  dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
  endDate: z.string().date().nullable().optional(),
  nextRunDate: z.string().date().optional(),
  isActive: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});

export type RecurringTemplateUpdate = z.infer<typeof recurringTemplateUpdateSchema>;

export const recurringGenerationRunCreateSchema = z.object({
  throughDate: z.string().date(),
  notes: z.string().nullable().optional(),
});
