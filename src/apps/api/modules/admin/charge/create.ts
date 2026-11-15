// POST /v1/admin/c/:cid/charges
// Cria uma charge manualmente (tipicamente payable - ex: fatura EDP).
// Charges receivable de quota são criadas por budget/generate-quotas;
// charges receivable de refaturação têm o endpoint dedicado
// /charges/:id/refacturations. Este handler é para casos ad-hoc.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { chargeCreateSchema } from "$api/libs/model/charge.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatChargeForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { assertOwnership } from "$api/libs/shared/assert_ownership.ts";
import { applyAutoOffset } from "$api/modules/admin/charge/auto_offset.ts";
// Charge code é atribuído por BEFORE INSERT trigger (component
// 010_trg_charge_code.sql) - não precisa de orquestração TS.
import { normalizeChargeInput } from "./defaults.ts";

export const createCharge = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const body = await dtoValidator(chargeCreateSchema, await ctx.req.json());

  // Valida ownership das FK ids vindas do body - sem isto, um manager de A
  // podia criar charge em A a referenciar unit/supplier/account de B.
  await assertOwnership(postgres, body, condominiumId, {
    unit: "unitId",
    supplier: "supplierId",
    account: "accountId",
  });

  const { nature, chargeType, competencePeriod } = normalizeChargeInput(body);
  const actor = requireActor(ctx);

  // INSERT charge (trigger emite ledger) + auto-offset opcional. Mirror da
  // PARTE 2 do antigo fn_charge_ai.
  const created = await postgres.transaction(async (tx) => {
    const [row] = await tx.insert(schema.charge).values({
      condominiumId,
      unitId: body.unitId ?? null,
      scope: body.unitId ? "unit" : "condominium",
      nature,
      chargeType,
      kind: body.kind,
      issueDate: body.issueDate,
      dueDate: body.dueDate ?? null,
      competencePeriod,
      originalAmount: body.amountCents,
      expectedAmount: body.amountCents,
      openAmount: body.amountCents,
      description: body.description,
      documentNumber: body.documentNumber ?? null,
      invoiceNumber: body.invoiceNumber ?? null,
      paymentMethod: body.paymentMethod ?? "manual",
      note: body.note ?? null,
      supplierId: body.supplierId ?? null,
      accountId: body.accountId ?? null,
      createdBy: actor,
      updatedBy: actor,
    }).returning();

    if (!row) {
      throw new AppError({
        message: "Erro ao criar charge",
        statusCode: STATUS_CODE.InternalServerError,
        code: "DB_ERROR",
      });
    }

    if (body.unitId && body.kind === "receivable") {
      await applyAutoOffset(tx, {
        chargeId: row.id,
        condominiumId,
        unitId: body.unitId,
        nature,
        openAmount: body.amountCents,
        status: row.status,
        kind: body.kind,
        issueDate: body.issueDate,
        actor: actor ?? {},
      }, new Date());
    }

    return row;
  });

  return ctx.json({ data: formatChargeForResponse(created) }, STATUS_CODE.Created);
};
