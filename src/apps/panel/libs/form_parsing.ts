// Helpers de parsing de form data do panel. Concentram a regra antes
// replicada em ~80 sites: sem default → ""; `emptyAsNull` → null;
// `default` → fallback; booleans aceitam "on"/"true"/"1".
// Só normaliza, não valida - caller rejeita valores incoerentes.

type FormValue = string | File | undefined;
type FormData = Record<string, FormValue>;

// ─── Strings ───────────────────────────────────────────────────────────────

// `String(form[key] ?? "").trim()` consolidado. `emptyAsNull` e `default`
// são mutuamente exclusivos no comportamento de vazio.
export function parseFormString(
  form: FormData,
  key: string,
  opts?: { emptyAsNull?: true; default?: never },
): string;
export function parseFormString(
  form: FormData,
  key: string,
  opts: { emptyAsNull: true; default?: never },
): string | null;
export function parseFormString(
  form: FormData,
  key: string,
  opts: { default: string; emptyAsNull?: never },
): string;
export function parseFormString(
  form: FormData,
  key: string,
  opts?: { emptyAsNull?: boolean; default?: string },
): string | null {
  const v = String(form[key] ?? "").trim();
  if (v) return v;
  if (opts?.emptyAsNull) return null;
  if (opts?.default !== undefined) return opts.default;
  return "";
}

// ─── Booleans (checkboxes HTML) ────────────────────────────────────────────

// Checkbox HTML: "on" (default do browser), "true", "1" → true; resto → false.
export function parseFormBool(form: FormData, key: string): boolean {
  const v = String(form[key] ?? "").trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
}

// ─── Integers ──────────────────────────────────────────────────────────────

// `parseInt` consolidado; `opts.default` (default 0) usado em vazio/NaN.
export function parseFormInt(
  form: FormData,
  key: string,
  opts?: { default?: number },
): number {
  const raw = String(form[key] ?? "").trim();
  if (!raw) return opts?.default ?? 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : (opts?.default ?? 0);
}
