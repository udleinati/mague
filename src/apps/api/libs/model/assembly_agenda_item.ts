import { z } from "zod";
import { AssemblyVoteValueSchema } from "$api/libs/enums.ts";

// Voto individual numa deliberação (Art. 1432-1434 CC). Quando passado no
// body da criação da decisão, o handler insere linhas em `core.assembly_vote`
// e os agregados `votes_*` são preenchidos pelo trigger SQL.
export const assemblyAgendaItemVoteSchema = z.object({
  unitId: z.string().min(1),
  vote: AssemblyVoteValueSchema,
  permillageApplied: z.number().positive(),
  occupantId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export const assemblyAgendaItemCreateSchema = z.object({
  sequence: z.number().int().positive(),
  subject: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
  itemType: z.string().max(40).nullable().optional(), // approve_budget, admin_election, approve_fcr_usage, info, ...
  refType: z.string().max(40).nullable().optional(), // budget, user, charge, ...
  refId: z.string().nullable().optional(),
  // Votos individuais (preferido). Quando passado, o trigger SQL agrega para
  // `votes_in_favor/against/abstain` automaticamente.
  votes: z.array(assemblyAgendaItemVoteSchema).optional(),
  // Votos agregados (legacy / quando o admin só sabe os totais). Aceito como
  // fallback se `votes` não vier - mas perde o requisito legal de identificar
  // quem votou como (Art. 1433.º recurso). UI nova deve preferir `votes`.
  votesInFavor: z.number().nonnegative().nullable().optional(),
  votesAgainst: z.number().nonnegative().nullable().optional(),
  votesAbstain: z.number().nonnegative().nullable().optional(),
  approved: z.boolean().nullable().optional(),
  notes: z.string().nullable().optional(),
  // Nota livre da votação (mostrada na ata junto ao resultado).
  voteNote: z.string().nullable().optional(),
});

// Tudo optional: o handler só atualiza campos presentes no body.
// Semântica: `undefined` = não mexer; `null` = limpar; valor = substituir.
export const assemblyAgendaItemUpdateSchema = z.object({
  sequence: z.number().int().positive().optional(),
  subject: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  itemType: z.string().max(40).nullable().optional(),
  refType: z.string().max(40).nullable().optional(),
  refId: z.string().nullable().optional(),
  // Votos individuais (replace-all). Quando passado, apaga TODOS os votos
  // existentes da deliberação e insere os novos - trigger SQL re-agrega.
  // Igual semântica do create. Ver `update_agenda_item.ts`.
  votes: z.array(assemblyAgendaItemVoteSchema).optional(),
  votesInFavor: z.number().nonnegative().nullable().optional(),
  votesAgainst: z.number().nonnegative().nullable().optional(),
  votesAbstain: z.number().nonnegative().nullable().optional(),
  approved: z.boolean().nullable().optional(),
  notes: z.string().nullable().optional(),
  voteNote: z.string().nullable().optional(),
});

export type AssemblyAgendaItemUpdate = z.infer<typeof assemblyAgendaItemUpdateSchema>;
