// Routes /admin/c/:cid/managers/* - DEPRECATED (ADR 0002). Gestão de admins
// consolidada em /admin/c/:cid/users; este ficheiro só faz redirect 308
// (preserva método) das URLs antigas para manter bookmarks vivos.

import type { Hono } from "hono";

export function registerManagersRoutes(panelRouter: Hono): void {
  panelRouter.all("/admin/c/:cid/managers", (c) => {
    const cid = c.req.param("cid");
    return c.redirect(`/admin/c/${cid}/users?filter=admin`, 308);
  });

  panelRouter.all("/admin/c/:cid/managers/*", (c) => {
    const cid = c.req.param("cid");
    return c.redirect(`/admin/c/${cid}/users?filter=admin`, 308);
  });
}
