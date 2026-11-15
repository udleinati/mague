// POST /bank_transactions/:id/allocate_to_{unit,supplier}
//
// Ambos os endpoints usam exatamente o mesmo flow - imputação automática
// segundo prioridade legal Art. 784º CC. A diferença é apenas o `target`
// passado a `executeAllocation` e a mensagem default das notes.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { z } from "zod";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { executeAllocation } from "$api/modules/admin/allocation/execute.ts";
import { previewAllocation } from "$api/modules/admin/allocation/preview.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

const unitSchema = z.object({
  unitId: z.string(),
  notes: z.string().optional(),
  // Include-list de charge_type elegíveis; omitido = todos (ex: só extraordinárias).
  chargeTypes: z.array(z.string()).optional(),
});
const supplierSchema = z.object({ supplierId: z.string(), notes: z.string().optional() });

export const allocateToUnit = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);
  const bankTransactionId = requireParam(ctx, "id");
  const { unitId, notes, chargeTypes } = await dtoValidator(unitSchema, await ctx.req.json());

  const result = await executeAllocation({
    bankTransactionId,
    condominiumId,
    target: { kind: "unit", unitId },
    actor,
    notes: notes ?? "Imputação automática por fração",
    chargeTypes,
  }, postgres);

  return ctx.json({
    data: { count: result.entries.length, allocations: result.entries },
  }, STATUS_CODE.Created);
};

// GET .../allocation_preview?unitId=&chargeTypes=quota,extraordinary_quota
// Dry-run: mostra quais charges seriam quitadas (total/parcial) sem executar.
export const allocationPreview = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const bankTransactionId = requireParam(ctx, "id");
  const unitId = ctx.req.query("unitId");
  if (!unitId) {
    throw new AppError({
      message: "unitId obrigatório para pré-visualizar a imputação.",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }
  const chargeTypesRaw = ctx.req.query("chargeTypes");
  const chargeTypes = chargeTypesRaw
    ? chargeTypesRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const result = await previewAllocation({
    bankTransactionId,
    condominiumId,
    target: { kind: "unit", unitId },
    chargeTypes,
  }, postgres);

  return ctx.json({ data: result });
};

export const allocateToSupplier = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);
  const bankTransactionId = requireParam(ctx, "id");
  const { supplierId, notes } = await dtoValidator(supplierSchema, await ctx.req.json());

  const result = await executeAllocation({
    bankTransactionId,
    condominiumId,
    target: { kind: "supplier", supplierId },
    actor,
    notes: notes ?? "Imputação automática por fornecedor",
  }, postgres);

  return ctx.json({
    data: { count: result.entries.length, allocations: result.entries },
  }, STATUS_CODE.Created);
};
