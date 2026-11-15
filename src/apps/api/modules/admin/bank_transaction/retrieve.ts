// GET /v1/admin/condominiums/:cid/bank_transactions/:id
//
// Uma bank_transaction. Aceita ?withSuggestions=1 (mesmo enriquecimento que listBankTransactions).
// Evita o pattern caro do panel: listBankTransactions({}) (~5000 rows) + .find(id) em JS.

import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { BANK_TRANSACTION_PROJECTION, formatBankTransactionForResponse } from "./_projection.ts";
import { applyMatchSuggestions } from "./suggest_match.ts";

export const getBankTransaction = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const txId = requireParam(ctx, "id");

  const wantSuggestions = ctx.req.query("withSuggestions") === "1" ||
    ctx.req.query("withSuggestions") === "true";

  const result = await postgres.query((db) =>
    db.query.bankTransaction.findFirst({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, txId),
          ops.eq(e.condominiumId, condominiumId),
        ),
      ...BANK_TRANSACTION_PROJECTION,
    })
  );
  const tx = findEntityOrFail(result, "Movimento bancário");

  let formatted = formatBankTransactionForResponse(tx);

  // Units + suppliers só se withSuggestions (2 queries pequenas extra).
  if (wantSuggestions) {
    const [units, suppliers] = await Promise.all([
      postgres.query((db) =>
        db.query.unit.findMany({
          columns: { id: true, designation: true, identifier: true, matchKeywords: true },
          where: (u, ops) =>
            ops.and(ops.eq(u.condominiumId, condominiumId), ops.isNull(u.deletedAt)),
        })
      ),
      postgres.query((db) =>
        db.query.supplier.findMany({
          columns: { id: true, name: true, matchKeywords: true },
          where: (s, ops) =>
            ops.and(ops.eq(s.condominiumId, condominiumId), ops.isNull(s.deletedAt)),
        })
      ),
    ]);
    const [enriched] = applyMatchSuggestions(
      [formatted as Parameters<typeof applyMatchSuggestions>[0][number]],
      units,
      suppliers,
    );
    formatted = enriched as typeof formatted;
  }

  return ctx.json({ data: formatted });
};
