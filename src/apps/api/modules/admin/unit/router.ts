import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { requireUnitInCondo } from "$api/middleware/require_unit_in_condo.ts";
import { listMeUnits } from "./list.ts";
import { getMeUnit } from "./retrieve.ts";
import { updateMeUnit } from "./update.ts";
import { deleteUnit } from "./delete.ts";
import { createMeUnit } from "./create.ts";
import { listUnitEmails } from "./list_emails.ts";
import { importTemplate } from "./import_template.ts";
import { importPreview } from "./import_preview.ts";
import { importCommit } from "./import_commit.ts";

export const adminUnitRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/units";

  // Import de frações + ocupantes via xlsx (antes do /:unitId para não colidir).
  route.get(`${basePath}/import/template.xlsx`, (ctx) => importTemplate(ctx));
  route.post(`${basePath}/import/preview`, (ctx) => importPreview(ctx, postgres));
  route.post(`${basePath}/import/commit`, (ctx) => importCommit(ctx, postgres));

  route.get(basePath, (ctx) => listMeUnits(ctx, postgres));
  route.post(basePath, (ctx) => createMeUnit(ctx, postgres));
  route.get(`${basePath}/:unitId`, (ctx) => getMeUnit(ctx, postgres));
  route.get(`${basePath}/:unitId/emails`, (ctx) => listUnitEmails(ctx, postgres));
  route.patch(`${basePath}/:unitId`, (ctx) => updateMeUnit(ctx, postgres));
  // delete carrega a fração só por id; retrieve/update já filtram por cid, este não.
  route.delete(`${basePath}/:unitId`, requireUnitInCondo(), (ctx) => deleteUnit(ctx, postgres));

  return route;
};
