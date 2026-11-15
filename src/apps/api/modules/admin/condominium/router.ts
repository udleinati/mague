import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { getMe } from "./retrieve.ts";
import { updateMe } from "./update.ts";

export const adminCondominiumRoutes = () => {
  const route = new Hono<ApiEnv>();
  // Plural + `/me` (convenção dos outros recursos): o cid vive no prefixo,
  // `/me` identifica o condomínio da scope sem repetir o id.
  route.get("/condominiums/me", (ctx) => getMe(ctx, postgres));
  route.patch("/condominiums/me", (ctx) => updateMe(ctx, postgres));
  return route;
};
