// POST /v1/admin/c/:cid/charges/:chargeId/refacturations
// Cria N charges receivable debit (chargeType='refacturation') a partir de uma
// charge payable original. fn_charge_ai trata do ledger. Parcial permitido;
// erro se a soma exceder o ainda refaturável.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { refacturationBatchSchema } from "$api/libs/model/charge.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatChargeForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { assertUnitsBelongBatch } from "$api/libs/shared/assert_ownership.ts";

export const createRefacturations = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const chargeId = requireParam(ctx, "chargeId");

  const original = await postgres.query((db) =>
    db.query.charge.findFirst({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, chargeId),
          ops.eq(e.condominiumId, condominiumId),
        ),
    })
  );
  const orig = findEntityOrFail(original, "Cobrança");

  if (orig.kind !== "payable") {
    throw new AppError({
      message: "Só é possível refaturar charges payable",
      statusCode: STATUS_CODE.BadRequest,
      code: "INVALID_KIND",
    });
  }

  const body = await dtoValidator(refacturationBatchSchema, await ctx.req.json());

  // Refaturável = originalAmount - já refaturado antes.
  const prevRefact = await postgres.query((db) =>
    db.query.charge.findMany({
      columns: { originalAmount: true },
      where: (e, ops) =>
        ops.and(
          ops.eq(e.condominiumId, condominiumId),
          ops.eq(e.chargeType, "refacturation"),
          ops.eq(e.sourceType, "refacturation"),
          ops.eq(e.sourceId, chargeId),
        ),
    })
  );

  const alreadyRefactured = prevRefact.reduce((s, c) => s + c.originalAmount, 0);
  const availableToRefact = orig.originalAmount - alreadyRefactured;
  const batchTotal = body.allocations.reduce((s, a) => s + a.amountCents, 0);

  if (batchTotal > availableToRefact) {
    throw new AppError({
      message:
        `Soma (${batchTotal}¢) excede disponível (${availableToRefact}¢). Já refaturado: ${alreadyRefactured}¢.`,
      statusCode: STATUS_CODE.BadRequest,
      code: "REFACTURATION_EXCEEDS_TOTAL",
    });
  }

  const uniqueUnitIds = [...new Set(body.allocations.map((a) => a.unitId))];
  await assertUnitsBelongBatch(postgres, uniqueUnitIds, condominiumId);

  const issueDate = body.issueDate ?? new Date().toISOString().slice(0, 10);
  const actor = requireActor(ctx);

  const rows = await postgres.query((db) =>
    db.transaction(async (tx) => {
      const inserted = [];
      // Competência herda da fatura original (mesmo mês da despesa redistribuída);
      // fallback defensivo para o issueDate se a source vier sem competência.
      const competence = orig.competencePeriod ??
        `${issueDate.slice(0, 7)}-01`;
      for (const alloc of body.allocations) {
        const [c] = await tx.insert(schema.charge).values({
          condominiumId,
          unitId: alloc.unitId,
          scope: "unit",
          nature: "debit",
          chargeType: "refacturation",
          kind: "receivable",
          issueDate,
          dueDate: body.dueDate,
          competencePeriod: competence,
          originalAmount: alloc.amountCents,
          expectedAmount: alloc.amountCents,
          openAmount: alloc.amountCents,
          description: alloc.description ?? `Refaturação: ${orig.description}`,
          sourceType: "refacturation",
          sourceId: chargeId,
          accountId: orig.accountId,
          createdBy: actor,
          updatedBy: actor,
        }).returning();
        inserted.push(c);
      }
      return inserted;
    })
  );

  return ctx.json({
    data: {
      created: rows.length,
      total_cents: batchTotal,
      remaining_cents: availableToRefact - batchTotal,
      charges: rows.map(formatChargeForResponse),
    },
  }, STATUS_CODE.Created);
};
