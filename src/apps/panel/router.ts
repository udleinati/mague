// Facade que monta as 4 partições de rotas (`routes/<grupo>.ts`):
//   - auth   → login, logout, accept-invite, password recovery, change-password
//   - super  → /choose-condominium
//   - admin  → /admin/c/:cid/* (charges, units, budgets, etc)
//   - portal → /portal/* (read-only ao condómino)

import { Hono } from "hono";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerSuperRoutes } from "./routes/super.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerPortalRoutes } from "./routes/portal.ts";

export const panelRouter = new Hono();

registerAuthRoutes(panelRouter);
registerSuperRoutes(panelRouter);
registerAdminRoutes(panelRouter);
registerPortalRoutes(panelRouter);
