// Seleção de condomínio ativo (super-admin / manager). Lista os condomínios
// acessíveis e redirige para /admin/c/<cid>/dashboard. Substituiu o cookie `cid`.

import type { Hono } from "hono";
import { currentUser } from "../context.ts";

export function registerSuperRoutes(panelRouter: Hono): void {
  panelRouter.get("/choose-condominium", async (c) => {
    const user = currentUser();
    if (!user) return c.redirect("/login");
    const { chooseCondominiumPage, listAccessibleCondominiums } = await import(
      "../controllers/auth.ts"
    );
    // Shortcut: se só existe um condomínio acessível (super ou manager),
    // entra diretamente sem mostrar página de escolha.
    const condos = await listAccessibleCondominiums();
    if (condos.length === 1) return c.redirect(`/admin/c/${condos[0].id}/dashboard`);

    // Só condómino (sem admin): vai para o portal da 1ª fração que ocupa.
    if (condos.length === 0 && user.occupantUnits && user.occupantUnits.length > 0) {
      const u = user.occupantUnits[0];
      return c.redirect(`/portal/c/${u.condominiumId}/u/${u.unitId}`);
    }

    return c.html(await chooseCondominiumPage());
  });
}
