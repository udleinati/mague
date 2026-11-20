// Valida `next` (path pós-login/pós-convite): só paths internos admin/portal,
// rejeita absolutas/protocol-relative - evita open redirect.
export function validateNextPath(next: string | undefined | null): string | null {
  if (!next || typeof next !== "string") return null;
  if (next.length > 2000) return null;
  // Decode antes de validar: `%2F%2Fevil.com` contorna o check `startsWith("//")`
  // porque o browser decodifica antes de seguir o redirect.
  let decoded: string;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/")) return null;
  if (decoded.startsWith("//")) return null; // protocol-relative
  if (decoded.includes("\\")) return null; // browser normalization tricks
  if (decoded.startsWith("/login") || decoded.startsWith("/logout")) return null;
  if (!decoded.startsWith("/admin/") && !decoded.startsWith("/portal/")) return null;
  return next; // devolve o original (não-decoded)
}
