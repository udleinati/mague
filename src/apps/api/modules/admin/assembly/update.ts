import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { calculateAssemblyQuorum } from "$api/libs/assembly/quorum_majority.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { assertOccupantBelongs, assertOwnership } from "$api/libs/shared/assert_ownership.ts";
import { assemblyUpdateSchema } from "$api/libs/model/assembly.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatAssemblyForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { canEditAgenda, canRecordMeeting } from "$shared/assembly/lifecycle.ts";
import {
  findPendingDeliberations,
  hasPendingDeliberations,
} from "$shared/assembly/deliberations.ts";

export const updateAssembly = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const assemblyId = requireParam(ctx, "assemblyId");

  const body = await dtoValidator(assemblyUpdateSchema, await ctx.req.json());

  const existing = await postgres.query((db) =>
    db.query.assembly.findFirst({
      where: byIdInCondo(schema.assembly, assemblyId, condominiumId),
    })
  );
  const data = findEntityOrFail(existing, "Assembleia");

  // Presidente e secretário assinam a ata: um ocupante de outro condomínio punha lá o nome dele.
  for (const occupantId of [body.presidentOccupantId, body.secretaryOccupantId]) {
    if (occupantId) await assertOccupantBelongs(postgres, occupantId, condominiumId);
  }
  await assertOwnership(postgres, body, condominiumId, { document: "minutesDocumentId" });

  // Lock duro: `held`/`cancelled` está selada (histórico oficial). `draft` e `scheduled`
  // são editáveis, com gates de campo distintos (ver abaixo). Ver $shared/assembly/lifecycle.ts.
  if (!canEditAgenda(data.status) && !canRecordMeeting(data.status)) {
    throw new AppError({
      message: "Assembleia já foi realizada ou cancelada - não é possível editar.",
      statusCode: STATUS_CODE.Conflict,
      code: "ASSEMBLY_LOCKED",
    });
  }

  // Convocada (`scheduled`): tipo, datas (1ª/2ª), local e textos da convocatória deixam
  // de mudar (foi o que os condóminos receberam); retificar (voltar a `draft`) para corrigir.
  // Defesa em profundidade.
  if (canRecordMeeting(data.status)) {
    const locked: string[] = [];
    if (body.type !== undefined && body.type !== data.type) locked.push("type");
    if (
      body.location !== undefined && (body.location ?? null) !== (data.location ?? null)
    ) locked.push("location");
    if (
      body.convocationIntro !== undefined &&
      (body.convocationIntro ?? null) !== (data.convocationIntro ?? null)
    ) locked.push("convocationIntro");
    if (
      body.convocationFooter !== undefined &&
      (body.convocationFooter ?? null) !== (data.convocationFooter ?? null)
    ) locked.push("convocationFooter");
    if (
      body.scheduledAt !== undefined &&
      new Date(body.scheduledAt).getTime() !== (data.scheduledAt?.getTime() ?? NaN)
    ) locked.push("scheduledAt");
    if (body.secondConvocationAt !== undefined) {
      const next = body.secondConvocationAt ? new Date(body.secondConvocationAt).getTime() : null;
      const prev = data.secondConvocationAt ? data.secondConvocationAt.getTime() : null;
      if (next !== prev) locked.push("secondConvocationAt");
    }
    if (locked.length > 0) {
      throw new AppError({
        message:
          "Assembleia convocada - a ordem do dia e os dados da convocatória estão travados. " +
          "Retifica (volta a rascunho) para corrigir.",
        statusCode: STATUS_CODE.Conflict,
        code: "CONVOCATION_LOCKED",
      });
    }
  }

  // ─── Pré-condições para selar como realizada (`held`) ─────────────────────
  if (body.status === "held") {
    // ─── Deliberações por registar (Art. 1432.º/1433.º) ──────────────────────
    // Selar a ata exige que cada ponto votável tenha resultado; pontos "info"
    // não se votam. Pontos "Aprovar orçamento" têm de indicar o orçamento.
    // Impede marcar como realizada sem deliberar a ordem do dia.
    const agendaItems = await postgres.query((db) =>
      db.query.assemblyAgendaItem.findMany({
        where: (e, ops) => ops.and(ops.eq(e.assemblyId, assemblyId), ops.isNull(e.deletedAt)),
        columns: { sequence: true, subject: true, itemType: true, approved: true, refId: true },
        orderBy: (e, { asc }) => [asc(e.sequence)],
      })
    );
    const pending = findPendingDeliberations(agendaItems);
    if (hasPendingDeliberations(pending)) {
      const fmt = (i: { sequence: number; subject: string }) => `#${i.sequence} ${i.subject}`;
      const parts: string[] = [];
      if (pending.undeliberated.length > 0) {
        parts.push("pontos por deliberar: " + pending.undeliberated.map(fmt).join("; "));
      }
      if (pending.missingBudgetRef.length > 0) {
        parts.push(
          "pontos 'Aprovar orçamento' sem orçamento indicado: " +
            pending.missingBudgetRef.map(fmt).join("; "),
        );
      }
      throw new AppError({
        message: "Não é possível marcar como realizada - " + parts.join(". ") +
          ". Delibera todos os pontos da ordem do dia primeiro.",
        statusCode: STATUS_CODE.UnprocessableEntity,
        code: "DELIBERATIONS_PENDING",
      });
    }

    // ─── Validação de quórum (Art. 1432.º nº 1) ──────────────────────────────
    // 'held' exige quórum (1ª: >50% da permilagem; 2ª: qualquer > 0). Skip quando o condo
    // não tem permilagem (sem units / todas inactive) - assembleia informativa ou setup.
    const round = body.convocationRound ?? data.convocationRound ?? "first";

    const [{ totalBuilding }] = await postgres.query((db) =>
      db.select({
        totalBuilding: sql<string>`COALESCE(SUM(${schema.unit.permillage}), 0)::text`,
      })
        .from(schema.unit)
        .where(
          sql`${schema.unit.condominiumId} = ${condominiumId} AND ${schema.unit.deletedAt} IS NULL`,
        )
    );

    if (Number(totalBuilding) > 0) {
      // 0 attendees = modo informativo/legacy (sem presenças), pula validação; com >=1
      // aplica a regra completa. Filtra pela convocatória atual (set presente NESSA ronda).
      const [{ attendeeCount, totalAttendee }] = await postgres.query((db) =>
        db.select({
          attendeeCount: sql<string>`COUNT(*)::text`,
          totalAttendee: sql<
            string
          >`COALESCE(SUM(${schema.assemblyAttendee.permillageAtMeeting}), 0)::text`,
        })
          .from(schema.assemblyAttendee)
          .where(
            sql`${schema.assemblyAttendee.assemblyId} = ${assemblyId}
                AND ${schema.assemblyAttendee.convocationRound} = ${round}
                AND ${schema.assemblyAttendee.deletedAt} IS NULL`,
          )
      );

      if (Number(attendeeCount) > 0) {
        const verdict = calculateAssemblyQuorum({
          totalAttendeePermillage: Number(totalAttendee),
          totalBuildingPermillage: Number(totalBuilding),
          round: round as "first" | "second",
        });
        if (!verdict.hasQuorum) {
          throw new AppError({
            message: `Não é possível marcar como realizada sem quórum: ${verdict.reason}`,
            statusCode: STATUS_CODE.UnprocessableEntity,
            code: "QUORUM_NOT_MET",
          });
        }
      }
    }
  }

  // ─── Side-effect: copiar presenças 1ª -> 2ª ───────────────────────────────
  // Ao passar de 'first' para 'second' sem linhas 'second', copia as da 1ª como ponto de
  // partida. Idempotente: `count('second') = 0` protege contra duplicação em re-flips.
  const transitioningToSecond = body.convocationRound === "second" &&
    data.convocationRound !== "second";
  if (transitioningToSecond) {
    const [{ secondCount }] = await postgres.query((db) =>
      db.select({
        secondCount: sql<string>`COUNT(*)::text`,
      })
        .from(schema.assemblyAttendee)
        .where(
          sql`${schema.assemblyAttendee.assemblyId} = ${assemblyId}
              AND ${schema.assemblyAttendee.convocationRound} = 'second'
              AND ${schema.assemblyAttendee.deletedAt} IS NULL`,
        )
    );
    if (Number(secondCount) === 0) {
      const firstRows = await postgres.query((db) =>
        db.query.assemblyAttendee.findMany({
          where: (e, ops) =>
            ops.and(
              ops.eq(e.assemblyId, assemblyId),
              ops.eq(e.convocationRound, "first"),
              ops.isNull(e.deletedAt),
            ),
        })
      );
      if (firstRows.length > 0) {
        await postgres.query((db) =>
          db.insert(schema.assemblyAttendee).values(
            firstRows.map((r) => ({
              assemblyId: r.assemblyId,
              unitId: r.unitId,
              occupantId: r.occupantId,
              convocationRound: "second" as const,
              permillageAtMeeting: r.permillageAtMeeting,
              isProxy: r.isProxy,
              proxyHolderOccupantId: r.proxyHolderOccupantId,
              proxyHolderExternalName: r.proxyHolderExternalName,
              arrivedAt: r.arrivedAt,
              leftAt: null, // a 2ª é nova - chega de novo, sem saída registada
              notes: r.notes,
              createdBy: actor,
              updatedBy: actor,
            })),
          )
        );
      }
    }
  }

  const update = await postgres.query((db) =>
    db.update(schema.assembly)
      .set({
        type: body.type ?? data.type,
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : data.scheduledAt,
        secondConvocationAt: body.secondConvocationAt !== undefined
          ? (body.secondConvocationAt ? new Date(body.secondConvocationAt) : null)
          : data.secondConvocationAt,
        heldAt: body.heldAt !== undefined
          ? (body.heldAt ? new Date(body.heldAt) : null)
          : data.heldAt,
        location: body.location !== undefined ? body.location : data.location,
        convocationSentAt: body.convocationSentAt !== undefined
          ? (body.convocationSentAt ? new Date(body.convocationSentAt) : null)
          : data.convocationSentAt,
        convocationRound: body.convocationRound ?? data.convocationRound,
        // Ata legal: 3 campos all-or-none (DB CHECK assembly_minutes_signed_consistency).
        presidentOccupantId: body.presidentOccupantId !== undefined
          ? body.presidentOccupantId
          : data.presidentOccupantId,
        secretaryOccupantId: body.secretaryOccupantId !== undefined
          ? body.secretaryOccupantId
          : data.secretaryOccupantId,
        // Coluna DATE - aceita string `YYYY-MM-DD`
        // direta, não precisa de `new Date(...)`.
        minutesSignedAt: body.minutesSignedAt !== undefined
          ? (body.minutesSignedAt || null)
          : data.minutesSignedAt,
        minutesNumber: body.minutesNumber !== undefined ? body.minutesNumber : data.minutesNumber,
        minutesDocumentId: body.minutesDocumentId !== undefined
          ? body.minutesDocumentId
          : data.minutesDocumentId,
        status: body.status ?? data.status,
        introduction: body.introduction !== undefined ? body.introduction : data.introduction,
        conclusion: body.conclusion !== undefined ? body.conclusion : data.conclusion,
        convocationIntro: body.convocationIntro !== undefined
          ? body.convocationIntro
          : data.convocationIntro,
        convocationFooter: body.convocationFooter !== undefined
          ? body.convocationFooter
          : data.convocationFooter,
        notes: body.notes !== undefined ? body.notes : data.notes,
        updatedAt: new Date(),
        updatedBy: actor,
      })
      .where(and(
        eq(schema.assembly.id, assemblyId),
        eq(schema.assembly.condominiumId, condominiumId),
        isNull(schema.assembly.deletedAt),
      ))
      .returning()
  );

  const updated = update[0];
  if (!updated) {
    throw new AppError({
      message: "Assembleia não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  // Retificar (scheduled -> draft): runs ativos passam a "superseded" (ficam para auditoria,
  // ADR 0034), zerando o cooldown - a convocatória corrigida vai a TODOS de novo.
  if (data.status === "scheduled" && body.status === "draft") {
    await postgres.query((db) =>
      db.update(schema.assemblyConvocation)
        .set({ supersededAt: new Date() })
        .where(and(
          eq(schema.assemblyConvocation.assemblyId, assemblyId),
          eq(schema.assemblyConvocation.condominiumId, condominiumId),
          isNull(schema.assemblyConvocation.supersededAt),
        ))
    );
  }

  return ctx.json({ data: formatAssemblyForResponse(updated) }, STATUS_CODE.OK);
};
