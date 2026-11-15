import { Hono } from "hono";
import { apiAuth } from "$api/middleware/api_auth.ts";
import { requireSuperRole } from "$api/middleware/require_super.ts";
import { requireAdminRole } from "$api/middleware/require_admin_role.ts";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { parseJson } from "$api/middleware/parse_json.ts";
import superRoutes from "./super/router.ts";
import adminRoutes from "./admin/router.ts";
import portalRoutes from "./portal/router.ts";
import { authRoutes } from "./auth/router.ts";

export const apiV1 = new Hono<ApiEnv>();

// Rotas de autenticação são públicas (login / me / logout) - sem apiAuth.
apiV1.use("/auth/*", parseJson());
apiV1.route("/", authRoutes());

apiV1.use("*", apiAuth());
apiV1.use("*", parseJson());

apiV1.use("/super/*", requireSuperRole());
apiV1.route("/super", superRoutes);

// Admin: scope-por-condomínio (path inclui /condominiums/:cid). `requireAdminRole`
// só deixa passar super ou manager do condo (occupants vão a /v1/portal/...).
apiV1.use("/admin/condominiums/:cid/*", requireAdminRole());
apiV1.route("/admin/condominiums/:cid", adminRoutes);

// Portal: dados das frações para occupants. Gate fino dentro de `portalRoutes`:
// `requirePortalAccessToCondo` (condo) e `requirePortalAccessToUnit` (`:unitId`).
// `:unitId` vem do path, não do query - impede escapar para outra fração.
apiV1.route("/portal", portalRoutes);
