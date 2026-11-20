import { AsyncLocalStorage } from "node:async_hooks";
import { panelConfig } from "./config.ts";

export interface PanelUser {
  id: string;
  email: string | null;
  /** Nullable. Para owners com fração, preferir occupant.name. */
  name: string | null;
  role: string;
  managedCondominiumIds: string[];
  /** Tema persistido. */
  theme: "light" | "dark" | null;
  /** Timestamp do "OK, entendi" no aviso de privacidade. NULL
   *  → middleware de portal redirecciona para /privacy-notice (exceto super). */
  termsAcknowledgedAt: string | null;
  /** Frações ligadas ativamente ao user (role=occupant); vazio para super/admin.
   *  `nif` é per-condo. Usado pelo selector + banner do portal. */
  occupantUnits: Array<{
    unitId: string;
    condominiumId: string;
    designation: string;
    identifier?: string | null;
    condominiumName?: string;
    occupantId: string;
    nif: string | null;
  }>;
}

export interface Flash {
  type: "success" | "error" | "warning" | "info";
  message: string;
}

export interface PanelRequestContext {
  condominiumId: string;
  user: PanelUser | null;
  /** JWT do /auth/login - usado em Authorization: Bearer. */
  token: string;
  /** Fração ativa no portal. Vem do `uid` no path `/portal/c/<cid>/u/<uid>`;
   *  `null` fora do portal. */
  portalUnitId: string | null;
  /** Mensagem de `?flash=…&flashType=…`. Populada em main.ts, injectada em
   *  todos os templates via render.ts. `null` sem mensagem. */
  flash: Flash | null;
  /** Origin público do pedido (`X-Forwarded-Proto` + `Host` do Caddy; dev →
   *  localhost). Enviado à API via `X-Panel-Base-URL` para links em emails
   *  sem depender de `PANEL_BASE_URL`. */
  requestOrigin: string;
  /** IP do cliente (1º `X-Forwarded-For` do Caddy). Repassado à API para o
   *  rate-limit do login e o IP de audit; sem ele tudo cai num IP único. */
  clientIp: string | null;
  /** Slot de memoização request-scoped do `loadPortalUnitContext()`
   *  (`getUnit + getCondominium` uma vez), partilhado render.ts/controllers.
   *  Mutável de propósito. */
  _portalCtx?: Promise<unknown> | undefined;
  /** Cache per-request do `loadCurrentCondominium()` (condominium.ts). */
  _condominium?: Promise<unknown> | undefined;
}

export const als = new AsyncLocalStorage<PanelRequestContext>();

// condominiumId do path (/c/<cid>/…), ou o default PANEL_CONDOMINIUM_ID.
export function currentCondominiumId(): string {
  return als.getStore()?.condominiumId ?? panelConfig.condominiumId;
}

export function currentUser(): PanelUser | null {
  return als.getStore()?.user ?? null;
}

export function currentToken(): string {
  return als.getStore()?.token ?? "";
}

export function currentFlash(): Flash | null {
  return als.getStore()?.flash ?? null;
}

/** Fração atual no portal; `null` fora dele. Controllers do portal filtram
 *  dados por isto - nunca por IDs de URL. */
export function currentPortalUnitId(): string | null {
  return als.getStore()?.portalUnitId ?? null;
}

/** Occupant do user na fração ativa do portal (cross-ref portalUnitId x
 *  occupantUnits). `null` fora do portal ou sem occupant. Usado pelo NIF banner. */
export function currentPortalOccupant(): { occupantId: string; nif: string | null } | null {
  const ctx = als.getStore();
  if (!ctx?.user || !ctx.portalUnitId) return null;
  const found = ctx.user.occupantUnits.find((u) => u.unitId === ctx.portalUnitId);
  if (!found) return null;
  return { occupantId: found.occupantId, nif: found.nif };
}

// Headers default das chamadas panel→API: `Authorization: Bearer <jwt>` (cid
// vai no path, não em header) e `X-Panel-Base-URL` (origin para links em
// emails) + IP do cliente em `x-forwarded-for`.
export function defaultApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { ...clientIpHeaders() };
  const token = currentToken();
  if (token) headers["authorization"] = `Bearer ${token}`;
  const origin = als.getStore()?.requestOrigin;
  if (origin) headers["x-panel-base-url"] = origin;
  return headers;
}

// Só o IP do cliente: serve o Client pré-login (/auth/*), sem token nem origin.
export function clientIpHeaders(): Record<string, string> {
  const ip = als.getStore()?.clientIp;
  return ip ? { "x-forwarded-for": ip } : {};
}
