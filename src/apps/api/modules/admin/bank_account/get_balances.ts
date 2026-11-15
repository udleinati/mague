// GET /v1/admin/c/:cid/bank-accounts/balances
//
// Saldo agregado do condomínio, separado em ordinário (121) e FCR (122).
// Computado do ledger (balance = Σ debits - Σ credits por account_code), não de
// bank_transaction.amount: movimentos por conciliar só entram no ledger via trigger
// quando há settlement. O ledger é a fonte de verdade contabilística.

import type { Context } from "hono";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";

// Bancos físicos (bolsas) - ver seeds/000a_chart_of_account_global.sql.
const ACC_ORDINARY = "121";
const ACC_FCR = "122";

export const getBankAccountsBalances = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const result = await postgres.query((db) =>
    db
      .select({
        accountCode: schema.ledger.accountCode,
        balance: sql<
          number
        >`SUM(CASE WHEN ${schema.ledger.direction} = 'debit' THEN ${schema.ledger.amount} ELSE -${schema.ledger.amount} END)`
          .as("balance"),
      })
      .from(schema.ledger)
      .where(and(
        eq(schema.ledger.condominiumId, condominiumId),
        inArray(schema.ledger.accountCode, [ACC_ORDINARY, ACC_FCR]),
      ))
      .groupBy(schema.ledger.accountCode)
  );

  const byCode = new Map<string, number>();
  for (const r of result) {
    byCode.set(r.accountCode, Number(r.balance) || 0);
  }

  const ordinaryCents = byCode.get(ACC_ORDINARY) ?? 0;
  const fcrCents = byCode.get(ACC_FCR) ?? 0;

  return ctx.json({
    data: {
      ordinaryCents,
      fcrCents,
      totalCents: ordinaryCents + fcrCents,
    },
  });
};
