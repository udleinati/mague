// Constrói `Flash` a partir da query string `?flash=msg&flashType=...`.
// Dois vocabulários: querystring (success|warning|info|danger) vs
// Flash.type (success|error|warning|info). Mapeia `danger -> error`,
// resto passa direto; `info` default quando só há mensagem.

import type { Context } from "hono";
import type { Flash } from "../context.ts";

export function parseFlashFromQuery(c: Context): Flash | null {
  const url = new URL(c.req.url);
  const message = url.searchParams.get("flash");
  if (!message) return null;
  const raw = url.searchParams.get("flashType") ?? "info";
  const type: Flash["type"] = raw === "danger"
    ? "error"
    : raw === "success" || raw === "warning"
    ? raw
    : "info";
  return { type, message };
}
