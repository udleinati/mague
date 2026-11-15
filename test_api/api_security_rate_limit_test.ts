// Pentest E2E para o rate-limit do login.
//
// Verifica que:
//   1. Counter por (identifier, IP) - atacante de IP X não pode trancar
//      a vítima legítima que entra de IP Y (DoS prevention).
//   2. Counter por (identifier, IP) bloqueia atacante persistente que
//      excede 5 falhas do mesmo IP.
//
// IPs aleatórios por run evitam pollution dos buckets em Valkey
// (TTL é 5 min - sem random IPs, re-correr a suite falha).
//
// **SKIP por default**: o `.env` local sobe os limites para 10k/100k para
// não saturar a suite API geral. Este teste só faz sentido com limites
// production-like - para correr:
//   1. No `.env`, baixar para `LOGIN_RATE_LIMIT_MAX_PER_IDENTIFIER_IP=5`,
//      `LOGIN_RATE_LIMIT_MAX_PER_IP_GLOBAL=100`.
//   2. `docker compose restart api` para o container ler a nova env.
//   3. `RUN_RATE_LIMIT_TEST=1 deno test --allow-net --allow-read --allow-env \
//      test_api/api_security_rate_limit_test.ts`
//   4. Reverter o `.env` ao acabar.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

const BASE_URL = "http://localhost:3000";
const VICTIM = { identifier: "super@mague.pt", password: "test" };
const SHOULD_SKIP = (Deno.env.get("RUN_RATE_LIMIT_TEST") ?? "0") !== "1";

async function loginAttempt(body: Record<string, string>, headers: Record<string, string> = {}) {
  const resp = await fetch(`${BASE_URL}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  await resp.body?.cancel();
  return resp.status;
}

// IPs únicos por run no espaço RFC 5737 (TEST-NET, nunca routável).
function uniqueIp(prefix: string): string {
  const octet = (Date.now() + Math.floor(Math.random() * 1000)) % 254 + 1;
  return `${prefix}.${octet}`;
}

describe("security - login rate limit", () => {
  it(
    "REGRESSION: atacante NÃO consegue trancar conta legítima " +
      "via 5 tentativas falhadas - credenciais correctas devem entrar.",
    { ignore: SHOULD_SKIP },
    async () => {
      const ATTACKER_IP = uniqueIp("203.0.113");
      const VICTIM_IP = uniqueIp("198.51.100");

      // Atacante: 5 tentativas com password errada
      for (let i = 1; i <= 5; i++) {
        const status = await loginAttempt(
          { identifier: VICTIM.identifier, password: `WRONG_${i}` },
          { "x-forwarded-for": ATTACKER_IP },
        );
        // 401 nas 4 primeiras, 429 na 5ª (atacante esgotou o seu próprio bucket)
        if (i < 5) {
          assertEquals(status, 401, `Tentativa ${i} devia ser 401 (password errada)`);
        }
      }

      // Vítima: login legítimo de IP DIFERENTE com password CORRECTA
      const victimStatus = await loginAttempt(VICTIM, { "x-forwarded-for": VICTIM_IP });

      // Bucket por (identifier, IP) → atacante não tranca vítima.
      assertEquals(
        victimStatus,
        200,
        `Vítima com password CORRECTA devia entrar (200) mas recebeu ${victimStatus}. ` +
          `Atacante de outro IP conseguiu trancar a conta - DoS de conta legítima.`,
      );
    },
  );

  it(
    "atacante a tentar a mesma conta do mesmo IP é bloqueado após 5 falhas (existing behaviour)",
    { ignore: SHOULD_SKIP },
    async () => {
      const ATTACKER_IP = uniqueIp("192.0.2");

      // 5 tentativas falhadas
      for (let i = 1; i <= 5; i++) {
        await loginAttempt(
          { identifier: VICTIM.identifier, password: "WRONG" },
          { "x-forwarded-for": ATTACKER_IP },
        );
      }

      // 6ª tentativa (mesmo IP, mesma conta): devia ser 429
      const status = await loginAttempt(
        { identifier: VICTIM.identifier, password: "WRONG" },
        { "x-forwarded-for": ATTACKER_IP },
      );
      assertEquals(status, 429, "Atacante persistente devia ser bloqueado");
    },
  );
});
