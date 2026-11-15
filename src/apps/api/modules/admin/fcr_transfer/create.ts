// POST /v1/admin/condominiums/:cid/fcr-transfers
//
// Move saldo entre a bolsa ordinária (121) e a bolsa FCR (122). Nenhum euro sai
// do banco - é reclassificação, e por isso não há bank_transaction nem charge.
// Em transação: INSERT fcr_transfer (âncora de auditoria, guarda o actor) +
// dupla partida manual no ledger, como no saldo de abertura.
//   to_fcr:      Dr 122 / Cr 121
//   to_ordinary: Dr 121 / Cr 122
// 422 se a bolsa de origem não cobre o montante (bolsa negativa não existe).

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { eq } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import {
  fcrTransferAccounts,
  fcrTransferCreateSchema,
  fcrTransferSourceBalance,
  fcrTransferSourceLabel,
} from "$api/libs/model/fcr_transfer.ts";
import { formatMoney } from "$shared/format/mod.ts";
import { formatFcrTransferForResponse } from "./_projection.ts";

export const createFcrTransfer = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const body = await dtoValidator(fcrTransferCreateSchema, await ctx.req.json());

  // Saldo das bolsas vem do ledger (v_bank_balance). Condomínio sem lançamentos
  // não tem linha na view - conta como zero.
  const balanceRow = await postgres.query((db) =>
    db.select().from(schema.bankBalance)
      .where(eq(schema.bankBalance.condominiumId, condominiumId))
  );
  const balances = {
    ordinaryCents: Number(balanceRow[0]?.ordinaryCents ?? 0),
    fcrCents: Number(balanceRow[0]?.fcrCents ?? 0),
  };

  const available = fcrTransferSourceBalance(body.direction, balances);
  if (body.amountCents > available) {
    throw new AppError({
      message: `Saldo insuficiente na ${fcrTransferSourceLabel(body.direction)}: ` +
        `disponível ${formatMoney(available)}, pedido ${formatMoney(body.amountCents)}.`,
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "FCR_TRANSFER_INSUFFICIENT_BALANCE",
    });
  }

  const accounts = fcrTransferAccounts(body.direction);
  const description = body.direction === "to_fcr"
    ? "Transferência para bolsa FCR"
    : "Transferência da bolsa FCR para ordinária";

  const created = await postgres.query((db) =>
    db.transaction(async (tx) => {
      const [transfer] = await tx.insert(schema.fcrTransfer).values({
        condominiumId,
        direction: body.direction,
        amountCents: body.amountCents,
        transferDate: body.date,
        reason: body.reason,
        createdBy: actor,
      }).returning();

      const ledgerLine = (accountCode: string, direction: "debit" | "credit") => ({
        condominiumId,
        unitId: null,
        entityType: "condominium",
        entryDate: body.date,
        entryType: "fcrTransfer",
        accountCode,
        direction,
        amount: body.amountCents,
        description,
        refType: "fcr_transfer",
        refId: transfer.id,
      });

      await tx.insert(schema.ledger).values([
        ledgerLine(accounts.debit, "debit"),
        ledgerLine(accounts.credit, "credit"),
      ]);

      return transfer;
    })
  );

  return ctx.json(
    { data: formatFcrTransferForResponse(created) },
    STATUS_CODE.Created,
  );
};
