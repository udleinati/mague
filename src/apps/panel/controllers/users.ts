import { render } from "$panel/render.ts";
import { client } from "$panel/client.ts";
import type { TemporaryPasswordReset } from "$shared/client/admin/user.ts";

export async function listUsers(
  flash: { type: string; message: string } | null = null,
  filter: "all" | "admin" | "occupant" = "all",
) {
  const usersResult = await client.admin.listUsers();

  const html = await render("pages/users/list.vto", {
    title: "Utilizadores",
    section: "users",
    users: usersResult.data,
    filter,
    flash,
  });
  return html;
}

/** Estado do cartão "Acesso" logo a seguir a um reset. `reset` traz a password
 *  temporária (só existe nesta renderização); `error` a mensagem da API. */
export interface AccessState {
  reset?: TemporaryPasswordReset;
  error?: string;
}

export async function getUser(
  userId: string,
  flash: { type: string; message: string } | null = null,
  access: AccessState | null = null,
) {
  const userResult = await client.admin.getUser(userId);

  const html = await render("pages/users/show.vto", {
    title: userResult.data.name,
    section: "users",
    target: userResult.data,
    flash,
    // Só populado logo a seguir ao reset - a página normal nunca o mostra.
    access,
  });
  return html;
}

/** Repõe a password e devolve o show.vto já com a temporária no ecrã. Nunca
 *  redireciona: por query string a password ficava no histórico do browser. */
export async function resetUserPassword(userId: string) {
  const { data } = await client.admin.resetUserPassword(userId);
  return await getUser(userId, null, { reset: data });
}

export async function getEditUser(
  userId: string,
  flash: { type: string; message: string } | null = null,
) {
  const userResult = await client.admin.getUser(userId);

  const html = await render("pages/users/edit.vto", {
    title: `Editar ${userResult.data.name}`,
    section: "users",
    target: userResult.data,
    flash,
  });
  return html;
}

export async function deleteUser(userId: string) {
  await client.admin.deleteUser(userId);
  return { ok: true };
}

export async function updateUser(userId: string, form: Record<string, string | File>) {
  const body: Record<string, unknown> = {};
  const strOrNull = (v: string | File | undefined) => {
    if (v === undefined) return undefined;
    const s = String(v).trim();
    return s === "" ? null : s;
  };
  if (form.name !== undefined) body.name = String(form.name).trim();
  if (form.phone !== undefined) body.phone = strOrNull(form.phone);
  if (form.nif !== undefined) body.nif = strOrNull(form.nif);
  // Toggle de administrador (Ver ADR 0002). Sentinel hidden distingue
  // "não submetido" de "submetido false" (checkbox só envia quando marcado).
  if (form.isManagerSubmitted !== undefined) {
    body.isManager = String(form.isManager ?? "") === "true";
  }
  await client.admin.updateUser(userId, body);
  return { ok: true };
}
