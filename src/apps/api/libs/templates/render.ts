// Setup mínimo de Vento para renderizar templates da API (PDFs de recibos,
// emails). Separado de `panel/render.ts` porque a API não precisa de globals
// request-scoped nem layouts, e corre template -> string (não HTTP response).

import vento from "vento";
import { fromFileUrl } from "@std/path";
import { formatDate as formatDateShared, formatMoney } from "$shared/format/mod.ts";

const TEMPLATES_DIR = fromFileUrl(new URL("../../templates/", import.meta.url));

const ventoEnv = vento({
  includes: TEMPLATES_DIR,
  autoescape: true,
});

// ─── Helpers (core partilhado em $shared/format) ───────────────────────

export { formatMoney };

// Política de fallback dos PDFs/emails: vazio → "-", inválido → string
// original (deixa passar valores já formatados).
export function formatDate(value: unknown): string {
  if (!value) return "-";
  const formatted = formatDateShared(value);
  return formatted === "" ? String(value) : formatted;
}

// "dd/mm/yyyy HH:mm" para PDFs/emails onde a hora importa (convocatória de
// assembleia). UTC, como `formatDate` (o render da API é sempre UTC; o do panel
// é local - contextos distintos).
export function formatDateTime(value: unknown): string {
  if (!value) return "-";
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

ventoEnv.filters.formatMoney = (c: unknown) => formatMoney(c);
ventoEnv.filters.formatDate = (v: unknown) => formatDate(v);
ventoEnv.filters.formatDateTime = (v: unknown) => formatDateTime(v);
ventoEnv.filters.num = (v: unknown) => (typeof v === "number" ? v : Number(v));

// Renderiza um template Vento por nome (relativo a `src/apps/api/templates/`).
export async function renderTemplate(
  name: string,
  data: Record<string, unknown>,
): Promise<string> {
  const result = await ventoEnv.run(name, data);
  return result.content;
}
