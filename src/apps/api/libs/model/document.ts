import { z } from "zod";

export const DOCUMENT_CATEGORIES = [
  "minutes",
  "regulation",
  "contract",
  "budget",
  "insurance",
  "plant",
  "other",
] as const;

export const documentCreateSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  category: z.enum(DOCUMENT_CATEGORIES).default("other"),
  isPublic: z.boolean().default(false),
  // Nullable: docs como regulamento ou plantas não têm data oficial.
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export const documentUpdateSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  isPublic: z.boolean().optional(),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
