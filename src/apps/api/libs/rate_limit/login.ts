// deno-lint-ignore-file no-explicit-any
//
// Rate limit de login via Valkey (fixed window com EXPIRE na 1ª tentativa).
// Duas dimensões: per-(identifier, IP) contra brute-force de uma origem, e
// per-IP global contra varrimento de contas do mesmo IP. Limites de
// `env.loginRateLimit.*` (defaults 5/100/300; dev desativa-os).
// CRÍTICO: a regra per-identifier inclui o IP no key, senão
// um atacante remoto tranca a vítima da própria conta (DoS por password errada).

import Valkey from "npm:iovalkey@0.3.3";
import { env } from "$config/env.ts";

const MAX_PER_IDENTIFIER_IP = env.loginRateLimit.maxPerIdentifierIp;
const MAX_PER_IP_GLOBAL = env.loginRateLimit.maxPerIpGlobal;
const WINDOW_SECONDS = env.loginRateLimit.windowSeconds;

let client: any = null;
function valkey(): any {
  if (!client) client = new (Valkey as any)(env.valkeyUrl, { lazyConnect: false });
  return client;
}

const KEY_IDENT_IP = (identifier: string, ip: string) =>
  `login_attempts:idip:${identifier.toLowerCase()}:${ip}`;
const KEY_IP = (ip: string) => `login_attempts:ip:${ip}`;

// Fallback quando IP é desconhecido (ex.: localhost sem x-forwarded-for):
// usa um placeholder fixo. Em prod o Caddy garante x-forwarded-for.
const FALLBACK_IP = "_unknown_";

export interface RateLimitResult {
  blocked: boolean;
  attempts: number;
  /** Segundos restantes até o counter expirar (-1 se não há TTL set). */
  retryAfterSeconds: number;
  /** Dimensão que disparou o bloqueio, se houver. */
  reason?: "identifier_ip" | "ip_global";
}

// Verifica bloqueio sem incrementar (chamar antes de autenticar). `blocked`
// se qualquer dimensão (identifier+ip ou ip global) atingiu o limite.
export async function checkLoginRateLimit(
  identifier: string,
  ip: string | null | undefined,
): Promise<RateLimitResult> {
  if (!identifier) return { blocked: false, attempts: 0, retryAfterSeconds: -1 };
  const ipKey = (ip ?? FALLBACK_IP).slice(0, 64); // sanity bound
  const c = valkey();
  const keyIdIp = KEY_IDENT_IP(identifier, ipKey);
  const keyIp = KEY_IP(ipKey);

  const [idIpAttemptsStr, idIpTtl, ipAttemptsStr, ipTtl] = await Promise.all([
    c.get(keyIdIp),
    c.ttl(keyIdIp),
    c.get(keyIp),
    c.ttl(keyIp),
  ]);
  const idIpAttempts = idIpAttemptsStr ? Number(idIpAttemptsStr) : 0;
  const ipAttempts = ipAttemptsStr ? Number(ipAttemptsStr) : 0;

  if (idIpAttempts >= MAX_PER_IDENTIFIER_IP) {
    return {
      blocked: true,
      attempts: idIpAttempts,
      retryAfterSeconds: idIpTtl > 0 ? idIpTtl : -1,
      reason: "identifier_ip",
    };
  }
  if (ipAttempts >= MAX_PER_IP_GLOBAL) {
    return {
      blocked: true,
      attempts: ipAttempts,
      retryAfterSeconds: ipTtl > 0 ? ipTtl : -1,
      reason: "ip_global",
    };
  }
  return {
    blocked: false,
    attempts: Math.max(idIpAttempts, ipAttempts),
    retryAfterSeconds: -1,
  };
}

// Incrementa ambos os counters (identifier-ip + ip-global) e define o EXPIRE
// da janela na 1ª tentativa de cada um.
export async function recordFailedAttempt(
  identifier: string,
  ip: string | null | undefined,
): Promise<{ idIpAttempts: number; ipAttempts: number }> {
  if (!identifier) return { idIpAttempts: 0, ipAttempts: 0 };
  const ipKey = (ip ?? FALLBACK_IP).slice(0, 64);
  const c = valkey();
  const keyIdIp = KEY_IDENT_IP(identifier, ipKey);
  const keyIp = KEY_IP(ipKey);

  const [idIpAttempts, ipAttempts] = await Promise.all([
    c.incr(keyIdIp),
    c.incr(keyIp),
  ]);
  if (idIpAttempts === 1) await c.expire(keyIdIp, WINDOW_SECONDS);
  if (ipAttempts === 1) await c.expire(keyIp, WINDOW_SECONDS);
  return { idIpAttempts, ipAttempts };
}

// Login OK: limpa só o counter (identifier, ip). O global por IP NÃO se limpa
// (só decai por timeout), senão um atacante recuperava o budget gasto a sondar
// contas alheias entrando na própria.
export async function clearLoginAttempts(
  identifier: string,
  ip: string | null | undefined,
): Promise<void> {
  if (!identifier) return;
  const ipKey = (ip ?? FALLBACK_IP).slice(0, 64);
  await valkey().del(KEY_IDENT_IP(identifier, ipKey));
}

export const RATE_LIMIT_MAX = MAX_PER_IDENTIFIER_IP;
export const RATE_LIMIT_WINDOW_SECONDS = WINDOW_SECONDS;
