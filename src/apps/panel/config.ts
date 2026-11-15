import "@std/dotenv/load";

function optional(name: string, fallback: string): string {
  return Deno.env.get(name) ?? fallback;
}

function asInt(value: string, name: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Variável ${name} deve ser um inteiro, recebi: ${value}`);
  }
  return n;
}

export const panelConfig = {
  condominiumId: optional("PANEL_CONDOMINIUM_ID", ""),
  apiUrl: optional("PANEL_API_URL", "http://localhost:3000"),
  port: asInt(optional("PANEL_PORT", "3400"), "PANEL_PORT"),
  /** Cap do cookie/JWT em dias; reflete `SESSION_EXPIRY_DAYS` da API. Ver ADR 0020. */
  sessionExpiryDays: asInt(optional("SESSION_EXPIRY_DAYS", "7"), "SESSION_EXPIRY_DAYS"),
} as const;
