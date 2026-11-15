// DELETE /recurring_templates/:id - soft-delete: não apaga charges já geradas,
// só impede futuras gerações (como desactivar, mas permanente e some do UI).

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const deleteRecurringTemplate = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const templateId = requireParam(ctx, "templateId");

  const existing = await postgres.query((db) =>
    db.query.recurringTemplate.findFirst({
      where: byIdInCondo(schema.recurringTemplate, templateId, condominiumId),
    })
  );
  findEntityOrFail(existing, "Template recorrente");

  await postgres.query((db) =>
    db.update(schema.recurringTemplate)
      .set({
        deletedAt: new Date(),
        deletedBy: actor,
        isActive: false,
        updatedAt: new Date(),
        updatedBy: actor,
      })
      .where(byIdInCondo(schema.recurringTemplate, templateId, condominiumId))
      .returning()
  );

  return new Response(null, { status: STATUS_CODE.NoContent });
};
