// /v1/portal/condominiums/:cid - metadata do condomínio (read-only).
// Reutiliza o retrieve admin (query simples por id + cid, sem dados sensíveis).

import type { Context } from "hono";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { getMe as getCondominiumMe } from "$api/modules/admin/condominium/retrieve.ts";

export const portalGetCondominium = (ctx: Context, postgres: Postgres) => {
  return getCondominiumMe(ctx, postgres);
};
