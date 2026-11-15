import { z } from "zod";

// Sem `userId`: a conta liga-se só pelo convite, que valida a quem pertence.
export const occupantCreateSchema = z.object({
  name: z.string().min(1, "name é obrigatório").max(255),
  email: z.string().email().nullable().optional(),
  nif: z.string().max(20).nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  // Natureza jurídica: singular (default) ou collective (empresa).
  personType: z.enum(["singular", "collective"]).optional(),
});

export const occupantUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  email: z.string().email().nullable().optional(),
  nif: z.string().max(20).nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  personType: z.enum(["singular", "collective"]).optional(),
  receiveReceiptEmails: z.boolean().optional(),
});

export type OccupantUpdate = z.infer<typeof occupantUpdateSchema>;
