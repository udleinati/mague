// Helpers para handlers do portal: extração do path scope (`cid` + `unitId`) e
// o cross-unit IDOR guard. O middleware `requirePortalAccessToUnit` valida o
// acesso à `:unitId`, mas não que a `:entityId` pertence a essa fração - isso
// fica a cargo destes helpers, standardizando o flow e testando o guard isolado.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import type { Postgres } from "$api/libs/postgres/postgres.ts";

export interface PortalScope {
  /** Condomínio do path. */
  cid: string;
  /** Fração do path. Já validada pelo middleware `requirePortalAccessToUnit` -
   *  o utilizador tem unit_occupant ativo aqui. */
  unitId: string;
}

/**
 * Lê `:cid` + `:unitId` do path. Atira 400 se um deles faltar (programmer
 * error: route mal montada).
 */
export function portalScope(ctx: Context): PortalScope {
  return {
    cid: requireParam(ctx, "cid"),
    unitId: requireParam(ctx, "unitId"),
  };
}

/**
 * Cross-unit IDOR guard: carrega a entidade scoped pela fração e atira 404 se
 * não existir OU não pertencer a `(cid, unitId)`. Sempre 404 (sem distinguir
 * "não existe" de "existe noutra fração") para não vazar existência. O `fetch`
 * compõe a query co-localizada com a tabela; o helper só controla o fluxo.
 *
 * @example
 *   const policy = await loadUnitOwnedEntity({
 *     ctx, paramName: "policyId", entityNamePT: "Apólice",
 *     fetch: ({ cid, unitId, id }, postgres) => postgres.query((db) =>
 *       db.query.insurancePolicy.findFirst({
 *         where: (p, ops) => ops.and(
 *           ops.eq(p.id, id),
 *           ops.eq(p.condominiumId, cid),
 *           ops.eq(p.unitId, unitId),
 *         ),
 *       })
 *     ),
 *   }, postgres);
 */
export async function loadUnitOwnedEntity<T>(
  args: {
    ctx: Context;
    /** Nome do path param que carrega o id da entidade (ex: "policyId"). */
    paramName: string;
    /** Label PT-PT usado na mensagem de erro (ex: "Apólice", "Ocorrência"). */
    entityNamePT: string;
    /** Carrega a entidade dado o scope. Devolve null/undefined se não existir/não pertence. */
    fetch: (
      args: PortalScope & { id: string },
      postgres: Postgres,
    ) => Promise<T | null | undefined>;
  },
  postgres: Postgres,
): Promise<{ scope: PortalScope; id: string; entity: NonNullable<T> }> {
  const scope = portalScope(args.ctx);
  const id = requireParam(args.ctx, args.paramName);
  const entity = await args.fetch({ ...scope, id }, postgres);
  if (entity === null || entity === undefined) {
    throw new AppError({
      message: `${args.entityNamePT} não encontrada`,
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  return { scope, id, entity: entity as NonNullable<T> };
}
