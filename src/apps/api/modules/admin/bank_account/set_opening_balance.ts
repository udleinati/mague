// POST /v1/admin/c/:cid/bank-accounts/:bankAccountId/opening-balance
//
// Saldo inicial dividido em ordinário e FCR (Fundo Comum de Reserva, Art. 1424.º-A CC).
// Em transação: UPDATE bank_account; 2 charges (scope=condominium, nature=credit,
// chargeType=openingBalance); ledger dupla partida:
//   Dr 121 Banco Ordinária / Cr 59 Resultados Transitados   (ordinário)
//   Dr 122 Banco FCR       / Cr 581 FCR                      (fcr)
// 121/122 separam a bolsa de asset (responde a "quanto do saldo é FCR?" sem cruzar equity).
// 409 se a conta já tem saldo inicial (existe charge openingBalance ligada a sourceId=bankAccount).

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

const bodySchema = z.object({
  ordinary_cents: z.number().int().min(0),
  fcr_cents: z.number().int().min(0),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).refine((b) => b.ordinary_cents + b.fcr_cents > 0, {
  message: "O saldo inicial total tem de ser > 0",
});

// Chart of accounts códigos SNC - ver seeds/000a_chart_of_account_global.sql
const ACC_BANK_ORDINARY = "121"; // Depósitos à ordem - Conta Ordinária (asset)
const ACC_BANK_FCR = "122"; // Depósitos à ordem - Conta FCR (asset, bolsa reservada)
const ACC_FCR = "581"; // Fundo Comum de Reserva / Reservas legais (equity)
const ACC_RETAINED = "59"; // Resultados Transitados (equity)

export const setOpeningBalance = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const bankAccountId = requireParam(ctx, "bankAccountId");

  const account = await postgres.query((db) =>
    db.query.bankAccount.findFirst({
      where: byIdInCondo(schema.bankAccount, bankAccountId, condominiumId),
    })
  );
  findEntityOrFail(account, "Conta bancária");

  const { ordinary_cents, fcr_cents, date } = await dtoValidator(bodySchema, await ctx.req.json());
  const total = ordinary_cents + fcr_cents;

  const actor = requireActor(ctx);

  // Competência = primeiro dia do mês (date já validado YYYY-MM-DD, slice seguro).
  const competencePeriod = `${date.slice(0, 7)}-01`;

  const result = await postgres.query((db) =>
    db.transaction(async (tx) => {
      // Lock da conta: serializa pedidos concorrentes antes do "já tem saldo inicial?".
      await tx.select({ id: schema.bankAccount.id }).from(schema.bankAccount)
        .where(eq(schema.bankAccount.id, bankAccountId)).for("update");

      // Já tem saldo inicial? (qualquer charge openingBalance ligada a esta conta)
      const existing = await tx.query.charge.findFirst({
        where: (e, ops) =>
          ops.and(
            ops.eq(e.condominiumId, condominiumId),
            ops.eq(e.chargeType, "openingBalance"),
            ops.eq(e.sourceType, "bank_account"),
            ops.eq(e.sourceId, bankAccountId),
          ),
      });
      if (existing) {
        throw new AppError({
          message: "Esta conta já tem saldo inicial definido. Anula o anterior antes de redefinir.",
          statusCode: STATUS_CODE.Conflict,
          code: "OPENING_BALANCE_ALREADY_SET",
        });
      }

      // 1. Update bank_account (cache para KPIs).
      await tx.update(schema.bankAccount)
        .set({
          openingBalance: total,
          openingBalanceOrdinaryCents: ordinary_cents,
          openingBalanceFcrCents: fcr_cents,
          openingBalanceDate: date,
        })
        .where(eq(schema.bankAccount.id, bankAccountId));

      // 2. Charges (fonte de verdade para auditoria).
      const chargeRows: Array<{ id: string; amount: number; account: string }> = [];
      if (ordinary_cents > 0) {
        const [c] = await tx.insert(schema.charge).values({
          condominiumId,
          unitId: null,
          scope: "condominium",
          nature: "credit",
          chargeType: "openingBalance",
          kind: "receivable",
          issueDate: date,
          competencePeriod,
          originalAmount: ordinary_cents,
          expectedAmount: ordinary_cents,
          openAmount: ordinary_cents,
          description: "Saldo inicial - ordinário",
          sourceType: "bank_account",
          sourceId: bankAccountId,
          accountId: null,
          createdBy: actor,
          updatedBy: actor,
        }).returning({ id: schema.charge.id });
        chargeRows.push({ id: c.id, amount: ordinary_cents, account: ACC_RETAINED });
      }
      if (fcr_cents > 0) {
        const [c] = await tx.insert(schema.charge).values({
          condominiumId,
          unitId: null,
          scope: "condominium",
          nature: "credit",
          chargeType: "openingBalance",
          kind: "receivable",
          issueDate: date,
          competencePeriod,
          originalAmount: fcr_cents,
          expectedAmount: fcr_cents,
          openAmount: fcr_cents,
          description: "Saldo inicial - FCR",
          sourceType: "bank_account",
          sourceId: bankAccountId,
          accountId: null,
          createdBy: actor,
          updatedBy: actor,
        }).returning({ id: schema.charge.id });
        chargeRows.push({ id: c.id, amount: fcr_cents, account: ACC_FCR });
      }

      // 3. Ledger: dupla partida manual (fn_charge_ai não emite para nature='credit').
      //    Dr banco + Cr equity por charge, separando a bolsa de asset (121 ord, 122 fcr).
      for (const r of chargeRows) {
        const isFcr = r.account === ACC_FCR;
        const bankAccountCode = isFcr ? ACC_BANK_FCR : ACC_BANK_ORDINARY;
        const desc = isFcr ? "Saldo inicial FCR" : "Saldo inicial ordinário";
        await tx.insert(schema.ledger).values([
          {
            condominiumId,
            unitId: null,
            entityType: "condominium",
            entryDate: date,
            entryType: "openingBalance",
            accountCode: bankAccountCode,
            direction: "debit",
            amount: r.amount,
            description: desc,
            refType: "charge",
            refId: r.id,
          },
          {
            condominiumId,
            unitId: null,
            entityType: "condominium",
            entryDate: date,
            entryType: "openingBalance",
            accountCode: r.account,
            direction: "credit",
            amount: r.amount,
            description: desc,
            refType: "charge",
            refId: r.id,
          },
        ]);
      }

      return { total, ordinary_cents, fcr_cents, chargesCreated: chargeRows.length };
    })
  );

  return ctx.json({
    data: {
      openingBalance: result.total,
      openingBalanceOrdinaryCents: result.ordinary_cents,
      openingBalanceFcrCents: result.fcr_cents,
      openingBalanceDate: date,
      chargesCreated: result.chargesCreated,
    },
  }, STATUS_CODE.Created);
};
