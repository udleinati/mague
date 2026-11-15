import { z } from "zod";

// Portuguese NIF/NIPC validation (9 digits)
const fiscalNumberSchema = z.string()
  .regex(/^\d{9}$/, "NIF deve ter 9 dígitos")
  .nullable()
  .optional();

// Portuguese postal code: 4 digits + hyphen + 3 digits
const postalCodeSchema = z.string()
  .regex(/^\d{4}-\d{3}$/, "Código postal inválido (formato: 0000-000)")
  .nullable()
  .optional();

const emailSchema = z.string().email().max(255).nullable().optional();

// 'building' = edifício único; 'condominium' = empreendimento / vários edifícios.
const designationTypeSchema = z.enum(["building", "condominium"]);

export const condominiumCreateSchema = z.object({
  name: z.string().min(1, "Nome é obrigatório").max(100),
  designationType: designationTypeSchema.default("condominium"),
  fiscalNumber: fiscalNumberSchema,
  email: emailSchema,
  address: z.string().max(200).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  postalCode: postalCodeSchema,
  quotaDayOfMonth: z.number().int().min(1).max(31).default(1),
});

export const condominiumUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  designationType: designationTypeSchema.optional(),
  fiscalNumber: fiscalNumberSchema,
  email: emailSchema,
  // BCC + Reply-To por condomínio. Aceitam null = limpar.
  bccEmail: emailSchema,
  replyToEmail: emailSchema,
  address: z.string().max(200).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  postalCode: postalCodeSchema,
  quotaDayOfMonth: z.number().int().min(1).max(31).optional(),
});

export type CondominiumUpdate = z.infer<typeof condominiumUpdateSchema>;
