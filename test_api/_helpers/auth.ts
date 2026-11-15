// Helper de autenticação para testes da API REST.
//
// Substitui o antigo pattern `{ "x-role": "master" }` que fazia bypass do
// fluxo real. Agora chamamos `/v1/auth/login` com o super-user seedado
// (super@mague.pt / test) e guardamos o JWT em cache para reutilizar entre
// testes - evita N logins numa run com ~150 steps.

const BASE_URL = "http://localhost:3000";
const SUPER_EMAIL = "super@mague.pt";
// Convention: super-user nos seeds (`deno task seed[:minimal]`) tem
// password "test". Override via `SUPER_PASSWORD` env var se precisares
// correr tests contra um DB com password diferente (ex: backup de prod).
const SUPER_PASSWORD = Deno.env.get("SUPER_PASSWORD") ?? "test";

let cachedToken: string | null = null;

/**
 * Login como super-user (seed minimal e normal têm super@mague.pt). Devolve
 * os headers prontos a injectar em qualquer chamada autenticada:
 *
 *     const headers = await loginAsSuper();
 *     // → { Authorization: "Bearer eyJ..." }
 *
 * O token é reutilizado na mesma run (singleton). Para forçar novo login,
 * chamar `resetAuthCache()`.
 */
export async function loginAsSuper(): Promise<{ Authorization: string }> {
  if (cachedToken) return { Authorization: `Bearer ${cachedToken}` };

  const res = await fetch(`${BASE_URL}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: SUPER_EMAIL, password: SUPER_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(
      `Login falhou (HTTP ${res.status}): ${await res.text()}. ` +
        `Confirma que o seed criou super@mague.pt/${SUPER_PASSWORD} (deno task seed) ` +
        `ou define SUPER_PASSWORD env var.`,
    );
  }
  const body = await res.json();
  const token = body?.data?.token;
  if (!token) throw new Error(`Resposta de login sem token: ${JSON.stringify(body)}`);
  cachedToken = String(token);
  return { Authorization: `Bearer ${cachedToken}` };
}

export function resetAuthCache(): void {
  cachedToken = null;
}

/**
 * Login com credenciais arbitrárias (não cached). Útil para testes de
 * autorização onde precisas de atuar como users diferentes (occupant,
 * outro manager, etc.) na mesma run de testes.
 *
 *     const aliceHeaders = await loginAs("alice@example.pt", "test12345");
 *     await client.admin.listCharges({ unitId: aliceUnit }, { headers: aliceHeaders });
 */
export async function loginAs(
  email: string,
  password: string,
): Promise<{ Authorization: string }> {
  const res = await fetch(`${BASE_URL}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`Login falhou para ${email}: HTTP ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const token = body?.data?.token;
  if (!token) throw new Error(`Resposta de login sem token: ${JSON.stringify(body)}`);
  return { Authorization: `Bearer ${token}` };
}
