// Projection partilhada por todos os handlers que devolvem assembleias. Padrão de
// charge/_projection.ts: PROJECTION = whitelist de columns na query; format() = whitelist
// final antes do JSON (defesa contra schema-drift expor colunas sensíveis tipo `deletedAt`).

import type { AssemblySelect } from "$api/libs/postgres/schemas/assembly.ts";

const ASSEMBLY_TOP_LEVEL_COLUMNS = {
  id: true,
  condominiumId: true,
  type: true,
  scheduledAt: true,
  secondConvocationAt: true,
  heldAt: true,
  location: true,
  convocationSentAt: true,
  convocationRound: true,
  presidentOccupantId: true,
  secretaryOccupantId: true,
  minutesSignedAt: true,
  minutesNumber: true,
  minutesDocumentId: true,
  status: true,
  introduction: true,
  conclusion: true,
  convocationIntro: true,
  convocationFooter: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} as const;

// `findMany`/`findFirst` config - espalha com `...ASSEMBLY_PROJECTION`.
export const ASSEMBLY_PROJECTION = {
  columns: ASSEMBLY_TOP_LEVEL_COLUMNS,
} as const;

type AssemblyRowLike = Partial<AssemblySelect>;

export function formatAssemblyForResponse(row: AssemblyRowLike) {
  return {
    id: row.id,
    condominiumId: row.condominiumId,
    type: row.type,
    scheduledAt: row.scheduledAt,
    secondConvocationAt: row.secondConvocationAt ?? null,
    heldAt: row.heldAt,
    location: row.location,
    convocationSentAt: row.convocationSentAt,
    convocationRound: row.convocationRound ?? "first",
    presidentOccupantId: row.presidentOccupantId ?? null,
    secretaryOccupantId: row.secretaryOccupantId ?? null,
    minutesSignedAt: row.minutesSignedAt ?? null,
    minutesNumber: row.minutesNumber,
    minutesDocumentId: row.minutesDocumentId,
    status: row.status,
    introduction: row.introduction ?? null,
    conclusion: row.conclusion ?? null,
    convocationIntro: row.convocationIntro ?? null,
    convocationFooter: row.convocationFooter ?? null,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
