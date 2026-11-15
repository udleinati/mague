// Routes /admin/c/:cid/* - facade que monta os sub-domínios. Cada sub-file vive
// em `routes/admin/<grupo>.ts` e exporta `register<Grupo>Routes(panelRouter)`.

import type { Hono } from "hono";
import { registerDashboardRoutes } from "./admin/dashboard.ts";
import { registerUnitsRoutes } from "./admin/units.ts";
import { registerCondominiumsRoutes } from "./admin/condominiums.ts";
import { registerBudgetRoutes } from "./admin/budget.ts";
import { registerAssemblyRoutes } from "./admin/assembly.ts";
import { registerChargesRoutes } from "./admin/charges.ts";
import { registerSuppliersRoutes } from "./admin/suppliers.ts";
import { registerRecurringRoutes } from "./admin/recurring.ts";
import { registerBankRoutes } from "./admin/bank.ts";
import { registerReconciliationRoutes } from "./admin/reconciliation.ts";
import { registerReceiptsRoutes } from "./admin/receipts.ts";
import { registerExpenseCategoriesRoutes } from "./admin/expense_categories.ts";
import { registerManagersRoutes } from "./admin/managers.ts";
import { registerUsersRoutes } from "./admin/users.ts";
import { registerOccupantsRoutes } from "./admin/occupants.ts";
import { registerInsurancesRoutes } from "./admin/insurances.ts";
import { registerInspectionsRoutes } from "./admin/inspections.ts";
import { registerBillingRemindersRoutes } from "./admin/billing_reminders.ts";
import { registerTicketsRoutes } from "./admin/tickets.ts";
import { registerDocumentsRoutes } from "./admin/documents.ts";
import { registerPathologiesRoutes } from "./admin/pathologies.ts";
import { registerReportsRoutes } from "./admin/reports.ts";

export function registerAdminRoutes(panelRouter: Hono): void {
  registerDashboardRoutes(panelRouter);
  registerUnitsRoutes(panelRouter);
  registerCondominiumsRoutes(panelRouter);
  registerBudgetRoutes(panelRouter);
  registerAssemblyRoutes(panelRouter);
  registerChargesRoutes(panelRouter);
  registerSuppliersRoutes(panelRouter);
  registerRecurringRoutes(panelRouter);
  registerBankRoutes(panelRouter);
  registerReconciliationRoutes(panelRouter);
  registerReceiptsRoutes(panelRouter);
  registerExpenseCategoriesRoutes(panelRouter);
  registerManagersRoutes(panelRouter);
  registerUsersRoutes(panelRouter);
  registerOccupantsRoutes(panelRouter);
  registerInsurancesRoutes(panelRouter);
  registerInspectionsRoutes(panelRouter);
  registerBillingRemindersRoutes(panelRouter);
  registerTicketsRoutes(panelRouter);
  registerDocumentsRoutes(panelRouter);
  registerPathologiesRoutes(panelRouter);
  registerReportsRoutes(panelRouter);
}
