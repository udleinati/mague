import { z } from "zod";
import {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_VISIBILITIES,
} from "$api/libs/postgres/schemas/ticket.ts";

// ─── Ticket ────────────────────────────────────────────────────────────────
export const ticketCreateSchema = z.object({
  title: z.string().min(1, "Título é obrigatório").max(200),
  description: z.string().max(5000).nullable().optional(),
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  unitId: z.string().nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  // Visibilidade. Default `admin_only`. Portal força
  // `admin_unit` no handler (ignora qualquer valor enviado).
  visibility: z.enum(TICKET_VISIBILITIES).optional(),
});
export const ticketUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  status: z.enum(TICKET_STATUSES).optional(),
  unitId: z.string().nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  visibility: z.enum(TICKET_VISIBILITIES).optional(),
  // Notas de resolução: aceitas mesmo sem mudar status para 'resolved'
  // (o admin pode editar progressivamente). O `resolvedAt` é gerido pelo
  // handler quando status passa a 'resolved'.
  resolutionNotes: z.string().max(5000).nullable().optional(),
  // Associação a patologia (ADR 0024). `null` para desassociar;
  // omitir para não tocar. Handler valida que a patologia pertence ao condo.
  pathologyId: z.string().nullable().optional(),
});
// ─── Comments ──────────────────────────────────────────────────────────────
export const ticketCommentSchema = z.object({
  comment: z.string().min(1, "Comentário é obrigatório").max(5000),
  isInternal: z.boolean().optional(),
});
