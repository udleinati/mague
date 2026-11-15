// POST /v1/admin/c/:cid/bank-accounts/:bankAccountId/import/commit
// Recebe a lista de linhas confirmadas pelo utilizador (output de preview)
// e grava bank_transactions. Re-verifica duplicados pelo import_hash antes
// de inserir para evitar race entre preview e commit.

import type { Context } from "hono";
import { z } from "zod";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { importHash } from "$api/libs/bank_import/hash.ts";

const rowSchema = z.object({
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  valueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  description: z.string(),
  amountCents: z.number().int(),
  balanceAfterCents: z.number().int().nullable().optional(),
});

const bodySchema = z.object({
  rows: z.array(rowSchema).min(1),
  filename: z.string().max(255).optional(),
});

export const importCommit = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const bankAccountId = requireParam(ctx, "bankAccountId");

  const account = await postgres.query((db) =>
    db.query.bankAccount.findFirst({
      where: byIdInCondo(schema.bankAccount, bankAccountId, condominiumId),
    })
  );
  findEntityOrFail(account, "Conta bancária");

  const body = await dtoValidator(bodySchema, await ctx.req.json());

  const now = new Date();

  const withHashes = await Promise.all(body.rows.map(async (r) => ({
    row: r,
    hash: await importHash({
      bankAccountId: bankAccountId,
      transactionDate: r.transactionDate,
      amountCents: r.amountCents,
      description: r.description,
      balanceAfterCents: r.balanceAfterCents ?? null,
    }),
  })));

  const hashes = withHashes.map((x) => x.hash);
  const existing = await postgres.query((db) =>
    db.query.bankTransaction.findMany({
      columns: { importHash: true },
      where: (e, ops) =>
        ops.and(
          ops.eq(e.condominiumId, condominiumId),
          ops.eq(e.bankAccountId, bankAccountId),
          ops.inArray(e.importHash, hashes),
        ),
    })
  );
  const existingHashes = new Set(existing.map((r) => r.importHash));

  const newRows = withHashes.filter((x) => !existingHashes.has(x.hash));

  if (newRows.length === 0) {
    return ctx.json({
      data: { created: 0, skipped: withHashes.length, importBatchId: null },
    });
  }

  // bank_import_batch primeiro (FK), depois as transactions, na mesma transação.
  const result = await postgres.query((db) =>
    db.transaction(async (tx) => {
      const [batch] = await tx.insert(schema.bankImportBatch).values({
        bankAccountId,
        condominiumId,
        filename: body.filename ?? null,
        rowsTotal: withHashes.length,
        rowsImported: newRows.length,
        rowsSkipped: withHashes.length - newRows.length,
      }).returning({ id: schema.bankImportBatch.id });

      const inserted = await tx.insert(schema.bankTransaction).values(
        newRows.map((x) => ({
          bankAccountId,
          condominiumId,
          transactionDate: x.row.transactionDate,
          valueDate: x.row.valueDate ?? null,
          amount: x.row.amountCents,
          description: x.row.description,
          balanceAfter: x.row.balanceAfterCents ?? null,
          importHash: x.hash,
          importBatchId: batch.id,
          createdAt: now,
        })),
      ).returning({ id: schema.bankTransaction.id });

      return { batchId: batch.id, insertedCount: inserted.length };
    })
  );

  return ctx.json({
    data: {
      created: result.insertedCount,
      skipped: withHashes.length - result.insertedCount,
      importBatchId: result.batchId,
    },
  });
};
