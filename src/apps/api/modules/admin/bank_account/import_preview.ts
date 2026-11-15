// POST /v1/admin/c/:cid/bank-accounts/:bankAccountId/import/preview
// Parseia o xlsx enviado e devolve cada linha candidata com flag
// `is_duplicate` (já existe um bank_transaction com o mesmo import_hash).
// Não grava nada. O utilizador confirma depois via endpoint /commit.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { parseNovoBancoXlsx } from "$api/libs/bank_import/novo_banco.ts";
import { importHash } from "$api/libs/bank_import/hash.ts";

export const importPreview = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const bankAccountId = requireParam(ctx, "bankAccountId");

  const account = await postgres.query((db) =>
    db.query.bankAccount.findFirst({
      where: byIdInCondo(schema.bankAccount, bankAccountId, condominiumId),
    })
  );
  findEntityOrFail(account, "Conta bancária");

  const form = await ctx.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new AppError({
      message: "Ficheiro em falta (campo 'file')",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = parseNovoBancoXlsx(bytes);

  const rowsWithHash = await Promise.all(parsed.rows.map(async (r) => ({
    ...r,
    import_hash: await importHash({
      bankAccountId: bankAccountId,
      transactionDate: r.transactionDate,
      amountCents: r.amountCents,
      description: r.description,
      balanceAfterCents: r.balanceAfterCents,
    }),
  })));

  const hashes = rowsWithHash.map((r) => r.import_hash);
  const existing = hashes.length > 0
    ? await postgres.query((db) =>
      db.query.bankTransaction.findMany({
        columns: { importHash: true },
        where: (e, ops) =>
          ops.and(
            ops.eq(e.condominiumId, condominiumId),
            ops.eq(e.bankAccountId, bankAccountId),
            ops.inArray(e.importHash, hashes),
          ),
      })
    )
    : [];
  const existingHashes = new Set(existing.map((r) => r.importHash));

  const rows = rowsWithHash.map((r) => ({
    ...r,
    is_duplicate: existingHashes.has(r.import_hash),
  }));

  const summary = {
    total: rows.length,
    new: rows.filter((r) => !r.is_duplicate).length,
    duplicates: rows.filter((r) => r.is_duplicate).length,
    warnings: parsed.warnings,
  };

  return ctx.json({ data: { rows, summary, filename: file.name } });
};
