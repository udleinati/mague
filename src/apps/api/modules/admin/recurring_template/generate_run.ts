// POST /recurring_templates/generate
//
// Despoleta geração em batch: o algoritmo (loop por templates × ocorrências
// até through_date, idempotência, advance de next_run_date) vive em
// `generator.ts` (TS, testável). Cada charge gerada chama applyAutoOffset.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { eq } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { recurringGenerationRunCreateSchema } from "$api/libs/model/recurring_template.ts";
import { formatRecurringGenerationRunForResponse } from "./_projection.ts";
import { runRecurringGeneration } from "./generator.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const triggerRecurringGenerationRun = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const body = await dtoValidator(recurringGenerationRunCreateSchema, await ctx.req.json());

  const result = await runRecurringGeneration({
    condominiumId,
    throughDate: body.throughDate,
    notes: body.notes ?? null,
    actor,
  }, postgres);

  // Re-fetch a row para devolver shape consistente com o serializer existente.
  const refetch = await postgres.query((db) =>
    db.select().from(schema.recurringGenerationRun)
      .where(eq(schema.recurringGenerationRun.id, result.runId))
  );

  return ctx.json(
    { data: formatRecurringGenerationRunForResponse(refetch[0]!) },
    STATUS_CODE.Created,
  );
};
