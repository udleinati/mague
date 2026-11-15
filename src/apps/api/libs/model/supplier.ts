import { z } from "zod";

export const supplierCreateSchema = z.object({
  name: z.string().min(1).max(255),
  nif: z.string().max(20).nullable().optional(),
  contactName: z.string().max(255).nullable().optional(),
  contactEmail: z.string().email().max(255).nullable().optional(),
  contactPhone: z.string().max(50).nullable().optional(),
  accountId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  matchKeywords: z.array(z.string().min(1).max(100)).max(30).optional(),
});

export const supplierUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  nif: z.string().max(20).nullable().optional(),
  contactName: z.string().max(255).nullable().optional(),
  contactEmail: z.string().email().max(255).nullable().optional(),
  contactPhone: z.string().max(50).nullable().optional(),
  accountId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  // Palavras-chave para sugestão automática na conciliação.
  matchKeywords: z.array(z.string().min(1).max(100)).max(30).optional(),
});

export type SupplierUpdate = z.infer<typeof supplierUpdateSchema>;
