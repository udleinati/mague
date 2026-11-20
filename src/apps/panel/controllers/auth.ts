import { render } from "$panel/render.ts";
import { Client } from "$shared/client/mod.ts";
import { panelConfig } from "$panel/config.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { clientIpHeaders } from "$panel/context.ts";
import { validateNextPath } from "$panel/libs/next_path.ts";

// Client sem defaults de role/cond - endpoints /auth/* são públicos. O IP do
// cliente vai sempre: o rate-limit do login conta por IP.
const client = new Client({ baseUrl: panelConfig.apiUrl, defaultHeaders: clientIpHeaders });

export async function loginPage(params: Record<string, string> = {}) {
  const flash = params.flash
    ? { type: params.flashType === "danger" ? "error" : "success", message: params.flash }
    : null;
  const next = params.next ?? null;
  // `identifier` (redirect pós-erro de credenciais) tem precedência sobre
  // `rememberedEmail` (cookie), p/ não reescrever o email após errar a password.
  const rememberedEmail = params.identifier ?? params.rememberedEmail ?? null;
  return await render("pages/auth/login.vto", {
    title: "Entrar",
    flash,
    next,
    rememberedEmail,
  });
}

export async function authenticate(form: Record<string, string | File>) {
  // `identifier` aceita email OU NIF. Mantém `email` para back-compat com
  // o form antigo (caso ainda exista bookmark/teste com esse name).
  const identifier = String(form.identifier ?? form.email ?? "").trim();
  const password = String(form.password ?? "");
  if (!identifier || !password) {
    throw new Error("Identificador (email ou NIF) e password são obrigatórios.");
  }
  const { data } = await client.auth.login(identifier, password);
  return data;
}

export async function loadSession(sessionId: string) {
  try {
    const { data } = await client.auth.me(sessionId);
    return data;
  } catch {
    return null;
  }
}

export async function logout(sessionId: string) {
  try {
    await client.auth.logout(sessionId);
  } catch { /* idempotent */ }
}

export async function changePassword(
  token: string,
  current: string,
  next: string,
  confirm: string,
) {
  if (!current) throw new Error("Senha atual é obrigatória.");
  if (!next) throw new Error("Nova senha é obrigatória.");
  if (next !== confirm) throw new Error("A nova senha e a confirmação não coincidem.");
  if (next.length < 8) throw new Error("Nova senha tem de ter pelo menos 8 caracteres.");
  if (current === next) throw new Error("Nova senha tem de ser diferente da atual.");
  await client.auth.changePassword(token, current, next);
}

// ── Convite + reset (sem auth) ────────────────────────────────────────────

// Anti open-redirect: mesma regra do `next` do login (`/\evil.com` passava).
export function sanitizeNext(raw: string | null | undefined): string | undefined {
  return validateNextPath(raw) ?? undefined;
}

/** GET /accept-invite?token=...&next=... - preview do convite. */
export async function previewInvitePage(token: string, params: Record<string, string> = {}) {
  if (!token) {
    return await render("pages/auth/accept_invite.vto", {
      error: "Convite em falta - usa o link que recebeste por email.",
    });
  }
  try {
    const { data } = await client.auth.previewInvite(token);
    const flash = params.flash
      ? { type: params.flashType === "danger" ? "error" : "success", message: params.flash }
      : null;
    return await render("pages/auth/accept_invite.vto", {
      token,
      user: data.user,
      expiresAt: new Date(data.expiresAt).toLocaleString("pt-PT"),
      flash,
      next: sanitizeNext(params.next),
    });
  } catch (err) {
    const { extractApiErrorMessage } = await import("../routes/_form_error.ts");
    const msg = extractApiErrorMessage(err, "Convite inválido");
    return await render("pages/auth/accept_invite.vto", { error: msg });
  }
}

/** POST /accept-invite - define password, devolve session token. */
export async function acceptInvite(form: Record<string, string | File>) {
  const token = parseFormString(form, "token");
  const password = String(form.password ?? "");
  const confirm = String(form.confirm ?? "");
  if (!token) throw new Error("Token em falta.");
  if (password.length < 8) throw new Error("Password tem de ter ≥8 caracteres.");
  if (password !== confirm) throw new Error("As passwords não coincidem.");
  const { data } = await client.auth.acceptInvite(token, password);
  return data;
}

export async function forgotPasswordPage(params: Record<string, string> = {}) {
  const flash = params.flash
    ? { type: params.flashType === "danger" ? "error" : "success", message: params.flash }
    : null;
  return await render("pages/auth/forgot_password.vto", { flash });
}

export async function forgotPassword(form: Record<string, string | File>) {
  const identifier = parseFormString(form, "identifier");
  if (!identifier) throw new Error("Identificador em falta.");
  await client.auth.forgotPassword(identifier);
  return { ok: true };
}

export async function resetPasswordPage(token: string, params: Record<string, string> = {}) {
  if (!token) {
    return await render("pages/auth/reset_password.vto", {
      error: "Link em falta - pede um novo no botão abaixo.",
    });
  }
  // Reusa o /auth/invite/:token endpoint para validar (mesma estrutura).
  try {
    const { data } = await client.auth.previewInvite(token);
    const flash = params.flash
      ? { type: params.flashType === "danger" ? "error" : "success", message: params.flash }
      : null;
    return await render("pages/auth/reset_password.vto", {
      token,
      user: data.user,
      flash,
    });
  } catch (err) {
    const { extractApiErrorMessage } = await import("../routes/_form_error.ts");
    const msg = extractApiErrorMessage(err, "Link inválido ou expirado");
    return await render("pages/auth/reset_password.vto", { error: msg });
  }
}

export async function resetPassword(form: Record<string, string | File>) {
  const token = parseFormString(form, "token");
  const password = String(form.password ?? "");
  const confirm = String(form.confirm ?? "");
  if (!token) throw new Error("Token em falta.");
  if (password.length < 8) throw new Error("Password tem de ter ≥8 caracteres.");
  if (password !== confirm) throw new Error("As passwords não coincidem.");
  const { data } = await client.auth.resetPassword(token, password);
  return data;
}

export async function listAccessibleCondominiums(): Promise<
  Array<{ id: string; name: string; city?: string | null }>
> {
  const { currentUser } = await import("$panel/context.ts");
  const user = currentUser();
  if (!user) return [];
  const { client: apiClient } = await import("$panel/client.ts");
  // Super: lista global via /v1/super/*. Restantes: o endpoint super está
  // bloqueado, então buscam-se um a um via /v1/admin/c/:cid/condominiums/me
  // (paralelo). Mesmo pattern usado em render.ts → getAvailableCondominiums.
  if (user.role === "super") {
    try {
      const r = await apiClient.super.listCondominiums();
      return r.data;
    } catch {
      return [];
    }
  }
  if (!user.managedCondominiumIds || user.managedCondominiumIds.length === 0) {
    return [];
  }
  const results = await Promise.all(
    user.managedCondominiumIds.map((cid) =>
      apiClient.admin.forCondominium(cid).getMe()
        .then((r) => r.data)
        .catch(() => null)
    ),
  );
  return results.filter((c): c is NonNullable<typeof c> => c != null);
}

export async function chooseCondominiumPage() {
  const { currentUser } = await import("$panel/context.ts");
  const user = currentUser();
  if (!user) return "";
  const condos = await listAccessibleCondominiums();
  return await render("pages/auth/choose_condominium.vto", {
    title: "Escolher condomínio",
    condos,
    user,
  });
}
