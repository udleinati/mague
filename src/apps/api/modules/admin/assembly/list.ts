// GET /v1/admin/condominiums/:cid/assemblies
//   ?status=scheduled|held|cancelled  -> filtra `status` (default: sem filtro)
//   ?limit=N                          -> cap nas linhas (default 500, max 1000)

import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { parseLimit } from "$api/libs/shared/pagination.ts";
import { ASSEMBLY_PROJECTION, formatAssemblyForScope } from "./_projection.ts";
import { type AssemblyScope, buildAssemblyListOrderBy, buildAssemblyListWhere } from "./_query.ts";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

// `scope` é injetado pelo caller, não vem da query string: admin (router)
// usa o default "all"; o portal (wrappers.ts) força "public" para esconder
// rascunhos. Ver ADR 0003 + `_query.ts`.
export const listAssemblies = async (
  ctx: Context,
  postgres: Postgres,
  opts: { scope?: AssemblyScope } = {},
) => {
  const scope = opts.scope ?? "all";
  const condominiumId = requireCondominiumId(ctx);

  const { status, limit: limitRaw } = ctx.req.query();
  const limit = parseLimit(limitRaw, { default: DEFAULT_LIMIT, max: MAX_LIMIT });

  const result = await postgres.query((db) =>
    db.query.assembly.findMany({
      where: buildAssemblyListWhere({ condominiumId, scope, status: status ?? null }),
      orderBy: buildAssemblyListOrderBy(),
      limit,
      ...ASSEMBLY_PROJECTION,
    })
  );

  const data = result.map((row) => formatAssemblyForScope(row, scope));
  return ctx.json({ data });
};
