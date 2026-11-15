// Wrappers finos sobre handlers `admin/...` reutilizados pelo portal: filtram
// só por `condominiumId` (já validado por `requirePortalAccessToCondo`). Seguro
// porque o handler admin usa `requireCondominiumId(ctx)` (mesmo `:cid`). Writes
// não se reutilizam - criam handler portal próprio.

import type { Context } from "hono";
import type { Postgres } from "$api/libs/postgres/postgres.ts";

import { listAssemblies } from "$api/modules/admin/assembly/list.ts";
import { getAssembly } from "$api/modules/admin/assembly/retrieve.ts";
import { listBudgets } from "$api/modules/admin/budget/list.ts";
import { getBudget } from "$api/modules/admin/budget/retrieve.ts";
import { getBudgetQuotaMap } from "$api/modules/admin/budget/quota_map.ts";
import { listBankAccounts } from "$api/modules/admin/bank_account/list.ts";
import { listPortalInspectionsHandler } from "$api/modules/admin/inspection/handlers.ts";

// Assembleias - `scope: "public"` esconde `draft` (lista) e 404 no detalhe
// (ADR 0003); rascunho é trabalho interno do admin.
export const portalListAssemblies = (ctx: Context, postgres: Postgres) =>
  listAssemblies(ctx, postgres, { scope: "public" });
export const portalGetAssembly = (ctx: Context, postgres: Postgres) =>
  getAssembly(ctx, postgres, { scope: "public" });

// Anexos da assembleia: handlers próprios em `portal/assembly_attachments.ts`
// (o admin não filtra draft - o portal precisa do gate de visibilidade).

// Orçamentos do condomínio.
export const portalListBudgets = (ctx: Context, postgres: Postgres) => listBudgets(ctx, postgres);
export const portalGetBudget = (ctx: Context, postgres: Postgres) => getBudget(ctx, postgres);
export const portalGetBudgetQuotaMap = (ctx: Context, postgres: Postgres) =>
  getBudgetQuotaMap(ctx, postgres);

// Contas bancárias - IBAN onde pagar. O serializer admin não expõe saldos/ledger.
export const portalListBankAccounts = (ctx: Context, postgres: Postgres) =>
  listBankAccounts(ctx, postgres);

// Inspeções "portal-friendly": já é uma view dedicada (descrição neutra,
// dados específicos para o condómino). Reutiliza-se diretamente.
export const portalListInspections = (ctx: Context, postgres: Postgres) =>
  listPortalInspectionsHandler(ctx, postgres);
