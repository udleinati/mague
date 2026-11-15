import { render } from "$panel/render.ts";
import { currentCondominiumId, currentUser } from "$panel/context.ts";
import { panelConfig } from "$panel/config.ts";
import { listAccessibleCondominiums } from "$panel/controllers/auth.ts";

// 404 do panel (rota desconhecida, cid inacessível, recurso interno em falta).
// Layout admin se autenticado, com cid = o atual se acessível, senão o primeiro.
export async function renderNotFound(opts: {
  heading?: string;
  subtitle?: string;
  attemptedPath?: string;
  showDashboard?: boolean;
  showChoose?: boolean;
} = {}): Promise<string> {
  const user = currentUser();
  const condos = user ? await listAccessibleCondominiums() : [];
  // Volta ao condomínio onde estava; o primeiro da lista trocava-o de condomínio sem aviso.
  const current = condos.find((c) => c.id === currentCondominiumId());
  const dashboardCid = current?.id ?? condos[0]?.id ?? panelConfig.condominiumId;
  return await render("pages/errors/not_found.vto", {
    title: "Não encontrado",
    section: "",
    condominium: null,
    heading: opts.heading,
    subtitle: opts.subtitle,
    attemptedPath: opts.attemptedPath,
    showDashboard: opts.showDashboard ?? !!user,
    showChoose: opts.showChoose ?? (user ? condos.length > 1 : false),
    dashboardCid,
  });
}

// 404 sem chrome admin: quando o user não deve ver o menu de gestão
// (occupant a tentar /admin/*, ou problemas dentro do portal).
export async function renderNotFoundNeutral(opts: {
  heading?: string;
  subtitle?: string;
  attemptedPath?: string;
} = {}): Promise<string> {
  return await render("pages/errors/not_found_neutral.vto", {
    title: "Não encontrado",
    heading: opts.heading,
    subtitle: opts.subtitle,
    attemptedPath: opts.attemptedPath,
  });
}
