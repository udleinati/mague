import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { listOccupants } from "./list.ts";
import { getOccupant } from "./retrieve.ts";
import { createOccupant } from "./create.ts";
import { updateOccupant } from "./update.ts";
import { deleteOccupant } from "./delete.ts";
import { listOccupantEmails } from "./list_emails.ts";
import { inviteByOccupant } from "$api/modules/auth/invite_by_occupant.ts";

export const occupantRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/occupants";

  route.get(basePath, (ctx) => listOccupants(ctx, postgres));
  route.get(`${basePath}/:occupantId`, (ctx) => getOccupant(ctx, postgres));
  route.get(`${basePath}/:occupantId/emails`, (ctx) => listOccupantEmails(ctx, postgres));
  route.post(basePath, (ctx) => createOccupant(ctx, postgres));
  route.patch(`${basePath}/:occupantId`, (ctx) => updateOccupant(ctx, postgres));
  route.delete(`${basePath}/:occupantId`, (ctx) => deleteOccupant(ctx, postgres));
  route.post(`${basePath}/:occupantId/invite`, (ctx) => inviteByOccupant(ctx, postgres));

  return route;
};
