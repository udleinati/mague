// DELETE /v1/admin/c/:cid/pathologies/:pathologyId
//
// Soft-delete + cascade S3 aos anexos (ADR 0021) via softDeletePathology.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { softDeletePathology } from "./_helpers.ts";

export const deletePathology = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const pathologyId = requireParam(ctx, "pathologyId");
  const actor = requireActor(ctx);
  const ok = await softDeletePathology(postgres, { condominiumId, pathologyId, actor });
  if (!ok) {
    throw new AppError({
      message: "Patologia não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  return new Response(null, { status: STATUS_CODE.NoContent });
};
