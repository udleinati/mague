// Helpers internos para os fluxos de auth com token (invite, reset).

import { customAlphabet } from "nanoid";

// Alfabeto URL-safe sem `-` (confunde-se com traço, parte em copy-paste de email).
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_";

const generate = customAlphabet(ALPHABET, 21);

/** Token URL-safe de 21 chars; entropia ~125.5 bits (≈ UUID v4, mínimo OWASP). */
export function generateAuthToken(): string {
  return generate();
}

// Password temporária ditada por voz/mensagem pelo admin: fora `0/O`, `1/I/L`
// e minúsculas, que se perdem ao telefone. 31^6 = ~29.7 bits - fraco para uma
// password permanente; ver o aviso no handler de reset.
const TEMP_PASSWORD_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const generateTempPassword = customAlphabet(TEMP_PASSWORD_ALPHABET, 6);

/** Password temporária de 6 chars sem caracteres confundíveis. */
export function generateTemporaryPassword(): string {
  return generateTempPassword();
}

/** Válido = ainda não usado e não expirado. */
export function isTokenValid(token: { expiresAt: Date; usedAt: Date | null }): boolean {
  if (token.usedAt !== null) return false;
  if (token.expiresAt.getTime() < Date.now()) return false;
  return true;
}

/** TTL de cada tipo de token (em segundos). */
export const TOKEN_TTL = {
  invite: 14 * 24 * 60 * 60, // 14 dias - margem confortável p/ convidado abrir o email
  reset: 60 * 60, // 1h
} as const;

/** Versão human-readable dos TTLs (para os emails). */
export const TOKEN_TTL_LABEL = {
  invite: "14 dias",
  reset: "1 hora",
} as const;
