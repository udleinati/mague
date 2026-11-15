import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { superCondominiumRoutes } from "./condominium/router.ts";
import { superUnitRoutes } from "./unit/router.ts";

const superRoutes = new Hono<ApiEnv>();
superRoutes.route("/", superCondominiumRoutes());
superRoutes.route("/", superUnitRoutes());

export default superRoutes;
