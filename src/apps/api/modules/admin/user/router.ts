import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { listUsers } from "./list.ts";
import { getUser } from "./retrieve.ts";
import { updateUser } from "./update.ts";
import { deleteUser } from "./delete.ts";
import { resetUserPassword } from "./reset_password.ts";

export const userRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/users";

  route.get(basePath, (ctx) => listUsers(ctx, postgres));
  route.get(`${basePath}/:userId`, (ctx) => getUser(ctx, postgres));
  route.patch(`${basePath}/:userId`, (ctx) => updateUser(ctx, postgres));
  route.delete(`${basePath}/:userId`, (ctx) => deleteUser(ctx, postgres));
  route.post(`${basePath}/:userId/reset-password`, (ctx) => resetUserPassword(ctx, postgres));

  return route;
};
