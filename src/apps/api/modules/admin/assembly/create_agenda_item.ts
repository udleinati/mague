// POST /assemblies/:assemblyId/agenda-items - cria ponto da ordem do dia.
// A transição `budget draft -> approved` NÃO acontece aqui: o trigger
// `trg_assembly_held_approve_budgets` processa-a quando a assembleia
// passa a `held` (um budget só é aprovado após a assembleia).

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { eq, sql } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { aggregateVotes, deriveApprovedFromVotes } from "$api/libs/assembly/quorum_majority.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { assertOwnership, assertVotesBelong } from "$api/libs/shared/assert_ownership.ts";
import { assemblyAgendaItemCreateSchema } from "$api/libs/model/assembly_agenda_item.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatAssemblyAgendaItemForResponse } from "./_projection_agenda_item.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { canEditAgenda } from "$shared/assembly/lifecycle.ts";

export const createAssemblyAgendaItem = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const assemblyId = requireParam(ctx, "assemblyId");

  const body = await dtoValidator(assemblyAgendaItemCreateSchema, await ctx.req.json());

  const assemblyResult = await postgres.query((db) =>
    db.query.assembly.findFirst({
      where: byIdInCondo(schema.assembly, assemblyId, condominiumId),
    })
  );
  const assembly = findEntityOrFail(assemblyResult, "Assembleia");

  // Ordem do dia editável só em RASCUNHO: acrescentar depois de convocada mudaria o
  // anunciado aos condóminos (Art. 1432.º nº 6). Ver $shared/assembly/lifecycle.ts.
  if (!canEditAgenda(assembly.status)) {
    throw new AppError({
      message: "A ordem do dia só pode ser alterada com a assembleia em rascunho.",
      statusCode: STATUS_CODE.Conflict,
      code: "AGENDA_LOCKED",
    });
  }

  // Quando `votes[]` vier no body, os agregados são derivados pelo trigger
  // `fn_assembly_vote_aggregate` (component 011) - ignoramos os campos
  // agregados do body. Sem `votes`, aceitamos os agregados directos (legacy).
  const hasIndividualVotes = (body.votes?.length ?? 0) > 0;
  if (hasIndividualVotes) await assertVotesBelong(postgres, body.votes!, condominiumId);
  // A BD só aceita ref_type 'budget': o refId é sempre um orçamento.
  await assertOwnership(postgres, body, condominiumId, { budget: "refId" });

  // ─── Resultado DERIVADO dos votos (Art. 1432.º nº 1+3 + 1422.º nº 2) ──────
  // `approved` deriva da regra de maioria do item_type, nunca do cliente (Regra 5).
  // Sem votos -> null (pendente); `info` -> null; com votos deriva-se aqui.
  const votesProvided = hasIndividualVotes ||
    body.votesInFavor != null || body.votesAgainst != null || body.votesAbstain != null;
  let derivedApproved: boolean | null = null;
  if (votesProvided) {
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
    if (body.itemType !== "info" && totalVotes > 0) {
      const [{ total }] = await postgres.query((db) =>
        db.select({
          total: sql<string>`COALESCE(SUM(${schema.unit.permillage}), 0)::text`,
        })
          .from(schema.unit)
          .where(
            sql`${schema.unit.condominiumId} = ${condominiumId} AND ${schema.unit.deletedAt} IS NULL`,
          )
      );
      derivedApproved = deriveApprovedFromVotes(body.itemType ?? null, agg, Number(total));
    }
  }

  const created = await postgres.transaction(async (tx) => {
    const [row] = await tx.insert(schema.assemblyAgendaItem).values({
      assemblyId,
      sequence: body.sequence,
      subject: body.subject,
      description: body.description ?? null,
      itemType: body.itemType ?? null,
      refType: body.refType ?? null,
      refId: body.refId ?? null,
      votesInFavor: hasIndividualVotes ? "0" : (body.votesInFavor?.toString() ?? null),
      votesAgainst: hasIndividualVotes ? "0" : (body.votesAgainst?.toString() ?? null),
      votesAbstain: hasIndividualVotes ? "0" : (body.votesAbstain?.toString() ?? null),
      approved: derivedApproved,
      notes: body.notes ?? null,
      voteNote: body.voteNote ?? null,
      createdBy: actor,
      updatedBy: actor,
    }).returning();

    if (hasIndividualVotes) {
      // Insert votos individuais - trigger agrega para `votes_*` automatic.
      await tx.insert(schema.assemblyVote).values(
        body.votes!.map((v) => ({
          assemblyAgendaItemId: row.id,
          unitId: v.unitId,
          vote: v.vote,
          permillageApplied: String(v.permillageApplied),
          occupantId: v.occupantId ?? null,
          notes: v.notes ?? null,
          createdBy: actor,
          updatedBy: actor,
        })),
      );
      // Re-leitura para retornar com totais agregados pelo trigger.
      const [refreshed] = await tx.select().from(schema.assemblyAgendaItem).where(
        eq(schema.assemblyAgendaItem.id, row.id),
      );
      return refreshed ?? row;
    }
    return row;
  });

  if (!created) {
    throw new AppError({
      message: "Erro ao criar deliberação",
      statusCode: STATUS_CODE.InternalServerError,
      code: "DB_ERROR",
    });
  }

  return ctx.json(
    { data: formatAssemblyAgendaItemForResponse(created) },
    STATUS_CODE.Created,
  );
};
