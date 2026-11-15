import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { listBankTransactions } from "./list.ts";
import { getBankTransaction } from "./retrieve.ts";
import { bankActivitySummary } from "./activity_summary.ts";
import { createBankTransaction } from "./create.ts";
import { allocateToSupplier, allocateToUnit, allocationPreview } from "./allocate.ts";
import { ignoreBankTransaction, unignoreBankTransaction } from "./set_ignored.ts";
import { reverseBankTransaction } from "./reverse.ts";
import { refundSupplier } from "./refund_supplier.ts";

// Settlements têm router próprio em `settlement/router.ts` - a "ownership"
// pertence a Settlement, não a BankTransaction.
export const bankTransactionRoutes = () => {
  const route = new Hono<ApiEnv>();

  route.get("/bank_transactions", (ctx) => listBankTransactions(ctx, postgres));
  // /activity_summary antes de /:id (Hono matches first-to-last).
  route.get(
    "/bank_transactions/activity_summary",
    (ctx) => bankActivitySummary(ctx, postgres),
  );
  route.get("/bank_transactions/:id", (ctx) => getBankTransaction(ctx, postgres));
  route.post("/bank_transactions", (ctx) => createBankTransaction(ctx, postgres));
  route.get(
    "/bank_transactions/:id/allocation_preview",
    (ctx) => allocationPreview(ctx, postgres),
  );
  route.post("/bank_transactions/:id/allocate_to_unit", (ctx) => allocateToUnit(ctx, postgres));
  route.post(
    "/bank_transactions/:id/allocate_to_supplier",
    (ctx) => allocateToSupplier(ctx, postgres),
  );
  route.post(
    "/bank_transactions/:id/refund_supplier",
    (ctx) => refundSupplier(ctx, postgres),
  );
  route.post("/bank_transactions/:id/ignore", (ctx) => ignoreBankTransaction(ctx, postgres));
  route.post("/bank_transactions/:id/unignore", (ctx) => unignoreBankTransaction(ctx, postgres));
  route.post("/bank_transactions/:id/reverse", (ctx) => reverseBankTransaction(ctx, postgres));

  return route;
};
