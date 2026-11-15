import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { login } from "./login.ts";
import { getAuthMe } from "./me.ts";
import { logout } from "./logout.ts";
import { changePassword } from "./change_password.ts";
import { acceptInvite, previewInvite } from "./accept_invite.ts";
import { forgotPassword, resetPassword } from "./forgot_password.ts";
import { saveTheme } from "./save_theme.ts";
import { saveTermsAcknowledged } from "./save_terms_acknowledged.ts";

export const authRoutes = () => {
  const route = new Hono<ApiEnv>();
  route.post("/auth/login", (ctx) => login(ctx, postgres));
  route.get("/auth/me", (ctx) => getAuthMe(ctx, postgres));
  route.post("/auth/logout", (ctx) => logout(ctx));
  route.post("/auth/change-password", (ctx) => changePassword(ctx, postgres));
  // Convite + reset (sem auth - validados por token de 1 uso).
  route.get("/auth/invite/:token", (ctx) => previewInvite(ctx, postgres));
  route.post("/auth/accept-invite", (ctx) => acceptInvite(ctx, postgres));
  route.post("/auth/forgot-password", (ctx) => forgotPassword(ctx, postgres));
  route.post("/auth/reset-password", (ctx) => resetPassword(ctx, postgres));
  // Preferência de tema (light/dark) persistida em core.user.theme.
  route.post("/auth/me/theme", (ctx) => saveTheme(ctx, postgres));
  // Aviso de privacidade do portal - write-once via COALESCE. Idempotente.
  route.post("/auth/me/terms-acknowledged", (ctx) => saveTermsAcknowledged(ctx, postgres));
  // NIF é per-occupant: ver portal/save_occupant_nif.ts.
  return route;
};
