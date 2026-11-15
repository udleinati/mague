import { z } from "zod";
import {
  AssemblyConvocationRoundSchema,
  AssemblyStatusSchema,
  AssemblyTypeSchema,
} from "$api/libs/enums.ts";

const assemblyTypeEnum = AssemblyTypeSchema;

export const assemblyCreateSchema = z.object({
  type: assemblyTypeEnum,
  scheduledAt: z.string().datetime({ offset: true }),
  // Data/hora da 2ª convocatória definida pelo admin (Art. 1432.º nº 4 CC).
  // Opcional na API mas DB CHECK garante >= scheduled_at quando preenchida.
  secondConvocationAt: z.string().datetime({ offset: true }).nullable().optional(),
  location: z.string().max(255).nullable().optional(),
  convocationSentAt: z.string().datetime({ offset: true }).nullable().optional(),
  convocationRound: AssemblyConvocationRoundSchema.optional(),
  minutesNumber: z.string().max(50).nullable().optional(),
  minutesDocumentId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const assemblyUpdateSchema = z.object({
  type: assemblyTypeEnum.optional(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  secondConvocationAt: z.string().datetime({ offset: true }).nullable().optional(),
  heldAt: z.string().datetime({ offset: true }).nullable().optional(),
  location: z.string().max(255).nullable().optional(),
  convocationSentAt: z.string().datetime({ offset: true }).nullable().optional(),
  convocationRound: AssemblyConvocationRoundSchema.optional(),
  // Ata legal (Art. 1434.º): presidente + secretário + data. Os 3 são
  // setados em conjunto (DB CHECK exige all-or-none). Tipicamente quando
  // status passa a 'held'. `minutesSignedAt` é DATE só.
  presidentOccupantId: z.string().nullable().optional(),
  secretaryOccupantId: z.string().nullable().optional(),
  minutesSignedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  minutesNumber: z.string().max(50).nullable().optional(),
  minutesDocumentId: z.string().nullable().optional(),
  status: AssemblyStatusSchema.optional(),
  // Texto narrativo da ata. Distintos de `notes`.
  introduction: z.string().nullable().optional(),
  conclusion: z.string().nullable().optional(),
  // Texto livre da CONVOCATÓRIA. Distintos da ata acima.
  // Editáveis só em `draft` (o handler trava-os quando `scheduled`).
  convocationIntro: z.string().nullable().optional(),
  convocationFooter: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export type AssemblyUpdate = z.infer<typeof assemblyUpdateSchema>;
