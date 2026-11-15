// deno-lint-ignore-file no-explicit-any
import Valkey from "npm:iovalkey@0.3.3";
import { nanoid } from "nanoid";
import { env } from "$config/env.ts";

export interface SessionData {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
}

let client: any = null;
function valkey(): any {
  if (!client) client = new (Valkey as any)(env.valkeyUrl, { lazyConnect: false });
  return client;
}

const KEY = (id: string) => `session:${id}`;

// Cria sessão no Valkey com TTL. O id é gerado aqui (não no store) para
// paridade com a versão DB.
export async function createSession(input: {
  userId: string;
  ttlSeconds: number;
  userAgent: string | null;
  ip: string | null;
}): Promise<SessionData> {
  // nanoid(32): 192 bits de entropia, URL-safe, 32 chars.
  const id = nanoid(32);
  const now = new Date();
  const data: SessionData = {
    id,
    userId: input.userId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000).toISOString(),
    userAgent: input.userAgent,
    ip: input.ip,
  };
  await valkey().set(KEY(id), JSON.stringify(data), "EX", input.ttlSeconds);
  return data;
}

export async function getSession(id: string): Promise<SessionData | null> {
  if (!id) return null;
  const raw = await valkey().get(KEY(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

export async function deleteSession(id: string): Promise<void> {
  if (!id) return;
  await valkey().del(KEY(id));
}

// Renova o TTL (sliding window, ADR 0020). Não toca no `expiresAt` do JSON,
// que reflete a expiração original do login (informativo); o TTL real é o do
// Valkey.
export async function refreshSessionTtl(id: string, ttlSeconds: number): Promise<void> {
  if (!id) return;
  await valkey().expire(KEY(id), ttlSeconds);
}
