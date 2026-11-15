// JWT como "envelope" do session-id em Valkey: o payload só carrega `sid`+`exp`,
// transportável em `Authorization: Bearer`. Sem claims ricas (uid/role/cids)
// para podermos revogar sessões instantaneamente - a fonte de verdade é Valkey.

import { create, getNumericDate, type Payload, verify } from "djwt";
import { env } from "$config/env.ts";

let keyPromise: Promise<CryptoKey> | null = null;
function key(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.sessionSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }
  return keyPromise;
}

/** Gera JWT assinado HS256 com `{sid, exp}`. */
export async function signSessionToken(sid: string, ttlSeconds: number): Promise<string> {
  const payload: Payload = {
    sid,
    exp: getNumericDate(ttlSeconds),
  };
  return await create({ alg: "HS256", typ: "JWT" }, payload, await key());
}

/** Valida a assinatura e devolve o sid, ou null se inválido/expirado. */
export async function verifySessionToken(token: string): Promise<string | null> {
  try {
    const payload = await verify(token, await key());
    const sid = (payload as Record<string, unknown>).sid;
    if (typeof sid !== "string" || !sid) return null;
    return sid;
  } catch {
    return null;
  }
}

// Extrai o sid de `Authorization: Bearer <token>`; null se ausente/inválido.
export async function extractSidFromBearer(
  authHeader: string | null | undefined,
): Promise<string | null> {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return await verifySessionToken(match[1].trim());
}
