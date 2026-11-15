import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { budgetCreateSchema } from "$api/libs/model/budget.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatBudgetForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const createBudget = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const body = await dtoValidator(budgetCreateSchema, await ctx.req.json());

  const isPrincipal = !body.parentBudgetId;
  const type = isPrincipal ? "principal" : "suplementar";

  // Vários principais para o mesmo ano são permitidos (distinção por notes).
  if (!isPrincipal && body.parentBudgetId) {
    const parent = await postgres.query((db) =>
      db.query.budget.findFirst({
        where: byIdInCondo(schema.budget, body.parentBudgetId!, condominiumId),
      })
    );
    if (!parent) {
      throw new AppError({
        message: "Orçamento pai não encontrado",
        statusCode: STATUS_CODE.NotFound,
        code: "NOT_FOUND",
      });
    }
    if (parent.type !== "principal") {
      throw new AppError({
        message: "Orçamento pai tem de ser do tipo principal",
        statusCode: STATUS_CODE.BadRequest,
        code: "VALIDATION_ERROR",
      });
    }
    if (String(parent.year) !== String(body.year)) {
      throw new AppError({
        message: `Suplementar tem de pertencer ao mesmo ano do pai (${parent.year})`,
        statusCode: STATUS_CODE.BadRequest,
        code: "VALIDATION_ERROR",
      });
    }
  }

  // Suplementar (obra) exige nº de prestações; principal mantém-se NULL (÷12).
  let installments: number | null = null;
  if (type === "suplementar") {
    if (!body.installments || body.installments < 1) {
      throw new AppError({
        message: "Orçamento suplementar exige o nº de prestações (>= 1)",
        statusCode: STATUS_CODE.BadRequest,
        code: "VALIDATION_ERROR",
      });
    }
    installments = body.installments;
  }

  // Suplementar (obra) nunca tem FCR: a obra não alimenta o fundo de reserva e
  // o ledger só faz split de FCR em quotas ordinárias. Força 0, ignora input.
  // Principal: 10% por defeito.
  const fcrPercentage = type === "suplementar" ? "0.00" : (body.fcrPercentage ?? "10.00");

  const insertRows = await postgres.query((db) =>
    db.insert(schema.budget).values({
      condominiumId,
      year: body.year,
      notes: body.notes ?? null,
      type,
      parentBudgetId: body.parentBudgetId ?? null,
      fcrPercentage,
      installments,
      createdBy: requireActor(ctx),
      updatedBy: requireActor(ctx),
    }).returning()
  );

  const created = insertRows[0];
  if (!created) {
    throw new AppError({
      message: "Erro ao criar orçamento",
      statusCode: STATUS_CODE.InternalServerError,
      code: "DB_ERROR",
    });
  }

  return ctx.json({ data: formatBudgetForResponse(created) }, STATUS_CODE.Created);
};
