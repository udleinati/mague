import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { listBankAccounts } from "./list.ts";
import { listBankAccountsWithStats } from "./list_with_stats.ts";
import { createBankAccount } from "./create.ts";
import { getBankAccount } from "./retrieve.ts";
import { updateBankAccount } from "./update.ts";
import { deleteBankAccount } from "./delete.ts";
import { importPreview } from "./import_preview.ts";
import { importCommit } from "./import_commit.ts";
import { setOpeningBalance } from "./set_opening_balance.ts";
import { getBankAccountsBalances } from "./get_balances.ts";

export const bankAccountRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/bank-accounts";

  route.get(basePath, (ctx) => listBankAccounts(ctx, postgres));
  route.post(basePath, (ctx) => createBankAccount(ctx, postgres));
  // `/balances` e `/with-stats` ANTES de `/:bankAccountId`, senão Hono lê a string fixa como id.
  route.get(`${basePath}/balances`, (ctx) => getBankAccountsBalances(ctx, postgres));
  route.get(`${basePath}/with-stats`, (ctx) => listBankAccountsWithStats(ctx, postgres));
  route.get(`${basePath}/:bankAccountId`, (ctx) => getBankAccount(ctx, postgres));
  route.patch(`${basePath}/:bankAccountId`, (ctx) => updateBankAccount(ctx, postgres));
  route.delete(`${basePath}/:bankAccountId`, (ctx) => deleteBankAccount(ctx, postgres));
  route.post(`${basePath}/:bankAccountId/import/preview`, (ctx) => importPreview(ctx, postgres));
  route.post(`${basePath}/:bankAccountId/import/commit`, (ctx) => importCommit(ctx, postgres));
  route.post(
    `${basePath}/:bankAccountId/opening-balance`,
    (ctx) => setOpeningBalance(ctx, postgres),
  );

  return route;
};
