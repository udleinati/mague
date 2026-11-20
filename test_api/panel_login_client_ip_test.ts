// E2E: o login pelo Panel chega à API com o IP do cliente.
//
// O Panel chama /v1/auth/login servidor-a-servidor. Sem repassar o
// `x-forwarded-for`, a API contava todos os logins no IP `_unknown_`: 5
// passwords erradas trancavam a vítima e 100 falhas trancavam o login de todos.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

const PANEL_URL = "http://localhost:3400";

async function valkey(...args: string[]): Promise<string> {
  const out = await new Deno.Command("docker", {
    args: ["exec", "mague-valkey", "valkey-cli", ...args],
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout).trim();
}

describe("security - Panel repassa o IP do cliente no login", () => {
  const identifier = `ip-probe-${Date.now()}@test.pt`;
  const clientIp = `203.0.113.${Date.now() % 254 + 1}`;
  const keyClientIp = `login_attempts:idip:${identifier}:${clientIp}`;
  const keyUnknown = `login_attempts:idip:${identifier}:_unknown_`;

  it("falha de login via Panel conta no IP do cliente, não em `_unknown_`", async () => {
    const res = await fetch(`${PANEL_URL}/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": clientIp,
      },
      body: new URLSearchParams({ identifier, password: "errada-123" }),
    });
    await res.body?.cancel();
    assertEquals(res.status, 302);

    assertEquals(await valkey("EXISTS", keyClientIp), "1");
    assertEquals(await valkey("EXISTS", keyUnknown), "0");
  });

  it("cleanup", async () => {
    await valkey("DEL", keyClientIp, keyUnknown);
  });
});
