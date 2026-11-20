import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatUnitForResponse, UNIT_PROJECTION } from "./_projection.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { and, eq, isNull } from "drizzle-orm";

// `onlyCurrentOccupants` (portal, não-admin): ligações terminadas levam
// email/telefone/NIF de ex-ocupantes e ficam de fora.
export const getMeUnit = async (
  ctx: Context,
  postgres: Postgres,
  opts: { onlyCurrentOccupants?: boolean } = {},
) => {
  const condominiumId = requireCondominiumId(ctx);

  const unitId = ctx.req.param("unitId");

  if (!unitId) {
    throw new AppError({
      message: "ID da fração inválido",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  // Em paralelo: fração (+ ocupantes) e balance (view v_unit_balance).
  const [unit, balanceRows] = await Promise.all([
    postgres.query((db) =>
      db.query.unit.findFirst({
        where: and(
          eq(schema.unit.id, unitId),
          eq(schema.unit.condominiumId, condominiumId),
          isNull(schema.unit.deletedAt),
        ),
        ...UNIT_PROJECTION,
      })
    ),
    postgres.query((db) =>
      db.select().from(schema.unitBalance).where(
        and(
          eq(schema.unitBalance.unitId, unitId),
          eq(schema.unitBalance.condominiumId, condominiumId),
        ),
      )
    ),
  ]);

  if (!unit) {
    throw new AppError({
      message: "Fração não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  const balance = balanceRows[0];
  const unitBalance = balance
    ? {
      openDebtCents: balance.openDebtCents,
      openCreditCents: balance.openCreditCents,
      overdueDebtCents: balance.overdueDebtCents,
      netCents: balance.netCents,
    }
    : undefined;

  const row = opts.onlyCurrentOccupants
    ? { ...unit, unitOccupants: unit.unitOccupants.filter((uo) => !uo.endDate) }
    : unit;
  return ctx.json({ data: formatUnitForResponse(row, { balance: unitBalance }) });
};
