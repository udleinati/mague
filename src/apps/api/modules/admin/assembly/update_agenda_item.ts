// PATCH /assemblies/:assemblyId/agenda-items/:agendaItemId - edita um ponto da ordem do dia.
// Guards (ver $shared/assembly/lifecycle.ts): `held`/`cancelled` -> 409 ASSEMBLY_LOCKED;
// `scheduled` (deliberação): o que se ANUNCIOU na convocatória (assunto/ordem/tipo) está travado
// -> 409 AGENDA_LOCKED; resultado (votos/aprovação/notas) + descrição + referência (não vão na
// convocatória) registam-se aqui; `draft` livre.
// Aprovação de budget é do trigger `trg_assembly_held_approve_budgets` (em `held`), não aqui.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { aggregateVotes, deriveApprovedFromVotes } from "$api/libs/assembly/quorum_majority.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { assertOwnership, assertVotesBelong } from "$api/libs/shared/assert_ownership.ts";
import { assemblyAgendaItemUpdateSchema } from "$api/libs/model/assembly_agenda_item.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatAssemblyAgendaItemForResponse } from "./_projection_agenda_item.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { canEditAgenda, canRecordMeeting } from "$shared/assembly/lifecycle.ts";

export const updateAssemblyAgendaItem = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const assemblyId = ctx.req.param("assemblyId");
  const agendaItemId = ctx.req.param("agendaItemId");
  if (!assemblyId || !agendaItemId) {
    throw new AppError({
      message: "assemblyId e agendaItemId são obrigatórios",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const body = await dtoValidator(assemblyAgendaItemUpdateSchema, await ctx.req.json());

  const assemblyResult = await postgres.query((db) =>
    db.query.assembly.findFirst({
      where: byIdInCondo(schema.assembly, assemblyId, condominiumId),
    })
  );
  const assembly = findEntityOrFail(assemblyResult, "Assembleia");

  // Selada depois de `held`/`cancelled`. `draft` e `scheduled` continuam.
  if (!canEditAgenda(assembly.status) && !canRecordMeeting(assembly.status)) {
    throw new AppError({
      message: "Assembleia já foi realizada ou cancelada - não é possível editar deliberações.",
      statusCode: STATUS_CODE.Conflict,
      code: "ASSEMBLY_LOCKED",
    });
  }

  const decisionResult = await postgres.query((db) =>
    db.query.assemblyAgendaItem.findFirst({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, agendaItemId),
          ops.eq(e.assemblyId, assemblyId),
          ops.isNull(e.deletedAt),
        ),
    })
  );
  const decision = findEntityOrFail(decisionResult, "Deliberação");

  // Convocada (`scheduled`): o que se ANUNCIOU na convocatória (assunto/ordem/tipo) está
  // travado; resultado/votos + descrição + referência registam-se na deliberação (não vão
  // na convocatória). Defesa em profundidade. Ver $shared/assembly/lifecycle.ts.
  if (canRecordMeeting(assembly.status)) {
    const agendaChanged = (body.subject !== undefined && body.subject !== decision.subject) ||
      (body.sequence !== undefined && Number(body.sequence) !== Number(decision.sequence)) ||
      (body.itemType !== undefined &&
        (body.itemType ?? null) !== (decision.itemType ?? null));
    if (agendaChanged) {
      throw new AppError({
        message: "Assembleia convocada - o assunto/ordem/tipo do ponto está travado. " +
          "Retifica (volta a rascunho) para alterar a ordem do dia anunciada.",
        statusCode: STATUS_CODE.Conflict,
        code: "AGENDA_LOCKED",
      });
    }
  }

  // `undefined`=manter, `null`=limpar, valor=substituir (Zod mantém a distinção).
  // `body.votes`: replace-all; o trigger `fn_assembly_vote_aggregate` (component 011) re-agrega
  // votes_*, fonte de verdade - quando `votes` vem, os agregados do body são ignorados.
  const hasIndividualVotes = !!body.votes;
  if (hasIndividualVotes) await assertVotesBelong(postgres, body.votes!, condominiumId);
  // A BD só aceita ref_type 'budget': o refId é sempre um orçamento.
  await assertOwnership(postgres, body, condominiumId, { budget: "refId" });

  // ─── Resultado DERIVADO dos votos (Art. 1432.º nº 1+3 + 1422.º nº 2) ──────
  // `approved` deriva da regra de maioria do item_type, nunca do cliente (Regra 5). Recompõe-se
  // só com votos no body; senão mantém o atual. `info`/sem votos (soma 0) -> null (pendente).
  const votesProvided = hasIndividualVotes ||
    body.votesInFavor !== undefined || body.votesAgainst !== undefined ||
    body.votesAbstain !== undefined;
  let derivedApproved: boolean | null = decision.approved;
  if (votesProvided) {
    const effType = body.itemType !== undefined ? body.itemType : decision.itemType;
    const agg = hasIndividualVotes
      ? aggregateVotes(
        body.votes!.map((v) => ({ vote: v.vote, permillageApplied: v.permillageApplied })),
      )
      : {
        votesInFavor: Number(body.votesInFavor ?? 0),
        votesAgainst: Number(body.votesAgainst ?? 0),
        votesAbstain: Number(body.votesAbstain ?? 0),
      };
    const totalVotes = agg.votesInFavor + agg.votesAgainst + agg.votesAbstain;
    if (effType === "info" || totalVotes <= 0) {
      derivedApproved = null;
    } else {
      const [{ total }] = await postgres.query((db) =>
        db.select({
          total: sql<string>`COALESCE(SUM(${schema.unit.permillage}), 0)::text`,
        })
          .from(schema.unit)
          .where(
            sql`${schema.unit.condominiumId} = ${condominiumId} AND ${schema.unit.deletedAt} IS NULL`,
          )
      );
      derivedApproved = deriveApprovedFromVotes(effType ?? null, agg, Number(total));
    }
  }

  const updated = await postgres.transaction(async (tx) => {
    const [row] = await tx.update(schema.assemblyAgendaItem)
      .set({
        sequence: body.sequence ?? decision.sequence,
        subject: body.subject ?? decision.subject,
        description: body.description !== undefined ? body.description : decision.description,
        itemType: body.itemType !== undefined ? body.itemType : decision.itemType,
        refType: body.refType !== undefined ? body.refType : decision.refType,
        refId: body.refId !== undefined ? body.refId : decision.refId,
        votesInFavor: hasIndividualVotes
          ? "0"
          : (body.votesInFavor !== undefined
            ? (body.votesInFavor?.toString() ?? null)
            : decision.votesInFavor),
        votesAgainst: hasIndividualVotes
          ? "0"
          : (body.votesAgainst !== undefined
            ? (body.votesAgainst?.toString() ?? null)
            : decision.votesAgainst),
        votesAbstain: hasIndividualVotes
          ? "0"
          : (body.votesAbstain !== undefined
            ? (body.votesAbstain?.toString() ?? null)
            : decision.votesAbstain),
        approved: derivedApproved,
        notes: body.notes !== undefined ? body.notes : decision.notes,
        voteNote: body.voteNote !== undefined ? body.voteNote : decision.voteNote,
        updatedBy: actor,
      })
      .where(and(
        eq(schema.assemblyAgendaItem.id, agendaItemId),
        eq(schema.assemblyAgendaItem.assemblyId, assemblyId),
        isNull(schema.assemblyAgendaItem.deletedAt),
      ))
      .returning();

    if (!row) return null;

    if (hasIndividualVotes) {
      // Replace-all: hard-delete (a tabela tem `deleted_at`, mas a edição não o usa) - o
      // ground truth é a versão atual da deliberação (votos tratáveis como replaceable).
      await tx.delete(schema.assemblyVote).where(
        eq(schema.assemblyVote.assemblyAgendaItemId, agendaItemId),
      );
      if (body.votes!.length > 0) {
        await tx.insert(schema.assemblyVote).values(
          body.votes!.map((v) => ({
            assemblyAgendaItemId: agendaItemId,
            unitId: v.unitId,
            vote: v.vote,
            permillageApplied: String(v.permillageApplied),
            occupantId: v.occupantId ?? null,
            notes: v.notes ?? null,
            createdBy: actor,
            updatedBy: actor,
          })),
        );
      }
      // Re-leitura para apanhar os totais agregados pelo trigger.
      const [refreshed] = await tx.select().from(schema.assemblyAgendaItem).where(
        eq(schema.assemblyAgendaItem.id, agendaItemId),
      );
      return refreshed ?? row;
    }
    return row;
  });

  if (!updated) {
    throw new AppError({
      message: "Deliberação não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  return ctx.json(
    { data: formatAssemblyAgendaItemForResponse(updated) },
    STATUS_CODE.OK,
  );
};
