// Espelha enums e regras do schema Drizzle de pathology. Ver ADR 0024.

import { z } from "zod";
import { PATHOLOGY_CATEGORIES, PATHOLOGY_STATUSES } from "$api/libs/postgres/schemas/pathology.ts";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "data deve ser YYYY-MM-DD");

// `unitIds`: array opcional de strings (IDs de frações). Validação cross-field
// "âmbito tem que existir" (affectsCommonArea OR ≥1 unit) é aplicada nos
// handlers create/update porque depende do estado atual em update.
const unitIdsField = z.array(z.string().min(1)).optional();

export const pathologyCreateSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(4000).nullable().optional(),
  category: z.enum(PATHOLOGY_CATEGORIES),
  // Status pode vir explícito (admin importa em estado específico) ou usar
  // default `draft` do schema. Não permitimos `dismissed` aqui sem reason -
  // CHECK constraint na BD apanha; aqui validamos cedo.
  status: z.enum(PATHOLOGY_STATUSES).default("draft"),
  affectsCommonArea: z.boolean().default(false),
  unitIds: unitIdsField,
  description_field_placeholder: z.never().optional(), // keep schema stable; ignored
  resolutionNotes: z.string().max(4000).nullable().optional(),
  dismissedReason: z.string().max(4000).nullable().optional(),
  detectedAt: isoDate.optional(),
  resolvedAt: isoDate.nullable().optional(),
  dismissedAt: isoDate.nullable().optional(),
}).refine(
  (v) => v.status !== "dismissed" || (v.dismissedReason && v.dismissedReason.trim().length > 0),
  { message: "dismissed_reason obrigatório quando status='dismissed'", path: ["dismissedReason"] },
).refine(
  (v) => v.affectsCommonArea === true || (v.unitIds && v.unitIds.length > 0),
  {
    message: "Pelo menos um âmbito é obrigatório: marca 'parte comum' OU seleciona ≥1 fração.",
    path: ["affectsCommonArea"],
  },
);

export const pathologyUpdateSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(4000).nullable().optional(),
  category: z.enum(PATHOLOGY_CATEGORIES).optional(),
  status: z.enum(PATHOLOGY_STATUSES).optional(),
  affectsCommonArea: z.boolean().optional(),
  // Substituição total da lista quando vier - omissão = não tocar.
  unitIds: unitIdsField,
  resolutionNotes: z.string().max(4000).nullable().optional(),
  dismissedReason: z.string().max(4000).nullable().optional(),
  detectedAt: isoDate.optional(),
  resolvedAt: isoDate.nullable().optional(),
  dismissedAt: isoDate.nullable().optional(),
});

export type PathologyUpdate = z.infer<typeof pathologyUpdateSchema>;
