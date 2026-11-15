import { currentCondominiumId } from "./context.ts";

export const ADMIN_PREFIX = "/admin/c";
export const PORTAL_PREFIX = "/portal/c";

// Prefixa um path com `/admin/c/<cid>/` (cid ativo do ALS), alinhado com o
// API. O atalho `/c/<cid>/...` redireciona com 308 (handler em main.ts).
export function condoUrl(path: string): string {
  const cid = currentCondominiumId();
  const clean = path.startsWith("/") ? path.slice(1) : path;
  return `${ADMIN_PREFIX}/${cid}/${clean}`;
}

// Prefixa um path com `/portal/c/<cid>/` (cid do ALS). Mesmo padrão de condoUrl().
export function portalUrl(path: string): string {
  const cid = currentCondominiumId();
  const clean = path.startsWith("/") ? path.slice(1) : path;
  return `${PORTAL_PREFIX}/${cid}/${clean}`;
}
