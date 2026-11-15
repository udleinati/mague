import { z } from "zod";

// `role` ausente de propósito: PATCH /users/:id não pode permitir
// auto-promoção (mudar role exige endpoint admin separado). `isManager`
// faz insert/soft-delete em `core.manager` (ADR 0002; 409 LAST_MANAGER ao
// remover o último admin). `nif`/`phone` vivem em core.occupant.
export const userUpdateSchema = z.object({
  name: z.string().min(1).max(255).nullable().optional(),
  isManager: z.boolean().optional(),
});

export type UserUpdate = z.infer<typeof userUpdateSchema>;
