// GET /v1/admin/c/:cid/charges/:chargeId/ledger
// Linhas de ledger que afetam a charge: diretas (ref_type='charge') e indiretas
// via settlements que a tocam (debit_charge_id OU credit_charge_id). Uso: página
// da charge mostrar o efeito contabilístico para auditoria.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, inArray, or } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { AppError } from "$api/libs/error/app_error.ts";

export const getChargeLedger = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const chargeId = requireParam(ctx, "chargeId");

  // Confirma tenant + 404 cedo (em vez de array vazio enganoso).
  const chargeExists = await postgres.query((db) =>
    db.query.charge.findFirst({
      columns: { id: true },
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, chargeId),
          ops.eq(e.condominiumId, condominiumId),
        ),
    })
  );
  if (!chargeExists) {
    throw new AppError({
      message: "Charge não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  // Settlements que tocam esta charge (debit OU credit).
  const settlements = await postgres.query((db) =>
    db.query.settlement.findMany({
      columns: { id: true },
      where: (e, ops) =>
        ops.and(
          ops.eq(e.condominiumId, condominiumId),
          ops.or(
            ops.eq(e.debitChargeId, chargeId),
            ops.eq(e.creditChargeId, chargeId),
          ),
        ),
    })
  );
  const settlementIds = settlements.map((s) => s.id);

  // Diretas + indiretas numa só query (OR). Filtro por condomínio = defesa
  // contra leak entre tenants.
  const ledger = await postgres.query((db) =>
    db.select().from(schema.ledger).where(and(
      eq(schema.ledger.condominiumId, condominiumId),
      or(
        and(
          eq(schema.ledger.refType, "charge"),
          eq(schema.ledger.refId, chargeId),
        ),
        settlementIds.length > 0
          ? and(
            eq(schema.ledger.refType, "settlement"),
            inArray(schema.ledger.refId, settlementIds),
          )
          : undefined,
      ),
    )).orderBy(schema.ledger.createdAt)
  );

  // Devolve `entryDate` como YYYY-MM-DD (Drizzle já o entrega assim para
  // colunas `date`). Restantes campos passam diretos - o panel formata.
  const data = ledger.map((l) => ({
    id: l.id,
    entryDate: l.entryDate,
    entryType: l.entryType,
    accountCode: l.accountCode,
    direction: l.direction,
    amount: l.amount,
    description: l.description,
    refType: l.refType,
    refId: l.refId,
    createdAt: l.createdAt,
  }));

  return ctx.json({ data });
};
