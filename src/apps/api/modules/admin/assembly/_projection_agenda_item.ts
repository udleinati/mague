// Projection partilhada para pontos da ordem do dia. Padrão de charge/_projection.ts:
// PROJECTION = whitelist de columns na query; format() = whitelist final antes do JSON.

import type { AssemblyAgendaItemSelect } from "$api/libs/postgres/schemas/assembly_agenda_item.ts";

type AssemblyAgendaItemRowLike = Partial<AssemblyAgendaItemSelect>;

export function formatAssemblyAgendaItemForResponse(row: AssemblyAgendaItemRowLike) {
  return {
    id: row.id,
    assemblyId: row.assemblyId,
    sequence: row.sequence,
    subject: row.subject,
    description: row.description,
    itemType: row.itemType,
    refType: row.refType,
    refId: row.refId,
    votesInFavor: row.votesInFavor,
    votesAgainst: row.votesAgainst,
    votesAbstain: row.votesAbstain,
    approved: row.approved,
    notes: row.notes,
    voteNote: row.voteNote,
    createdAt: row.createdAt,
  };
}
