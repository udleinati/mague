// E2E security: phishing-via-header em endpoints que usam X-Panel-Base-URL.
//
// Threat: o /forgot-password é PÚBLICO. Atacante envia POST com header
// `X-Panel-Base-URL: https://evil.com` indicando uma vítima. A API gera
// token real, envia email ao victim com link `https://evil.com/reset-password?...`
// → vítima clica, atacante captura o token e toma a conta.
//
// Fix: `safePanelBaseUrl()` valida o header contra `env.panelBaseUrl` (origin
// allowlist). Headers fora da allowlist são ignorados; usa env.

import { assertEquals, assertNotEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import postgresjs from "postgresjs";
import bcrypt from "npm:bcryptjs@2.4.3";

const BASE_URL = "http://localhost:3000";
const DATABASE_URL = Deno.env.get("DATABASE_URL") ??
  "postgres://mague:mague@localhost:5432/mague";
const sql = postgresjs(DATABASE_URL, { max: 2 });

describe("security - X-Panel-Base-URL allowlist (phishing-via-header)", () => {
  const stamp = Date.now();
  const victimEmail = `phish-victim-${stamp}@test.pt`;
  let victimUserId = "";

  it("setup - cria vítima com password", async () => {
    const hash = await bcrypt.hash("VictimPass1234", 10);
    const r = await sql<{ id: string }[]>`
      INSERT INTO core.user (name, email, role, is_active, password_hash)
      VALUES ('Phish Victim', ${victimEmail}, NULL, true, ${hash})
      RETURNING id
    `;
    victimUserId = r[0].id;
  });

  it("attack: forgot-password com X-Panel-Base-URL=https://evil.com NÃO usa esse origin", async () => {
    const res = await fetch(`${BASE_URL}/v1/auth/forgot-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Panel-Base-URL": "https://evil.com",
      },
      body: JSON.stringify({ identifier: victimEmail }),
    });
    // forgot-password sempre devolve 200/204 (anti-enumeração).
    assertEquals(res.status === 200 || res.status === 204, true);
    await res.body?.cancel();

    // Esperamos um token ativo de reset criado para a vítima - vamos
    // validar que o link enviado por email NÃO é evil.com. Como não temos
    // acesso directo ao body do email aqui, validamos o BASE de envio
    // através do mailpit (parseamos o último email enviado).
    // Pequeno wait para o envio chegar ao mailpit.
    await new Promise((r) => setTimeout(r, 300));

    const mp = await fetch(`http://localhost:8025/api/v1/messages?limit=1`);
    const list = await mp.json() as {
      messages: Array<{ ID: string; To: Array<{ Address: string }>; Subject: string }>;
    };
    const recent = list.messages.find((m) =>
      m.To.some((t) => t.Address === victimEmail) && m.Subject.includes("Reset")
    );
    assertNotEquals(recent, undefined, "email de reset não chegou ao mailpit");

    // Carrega o body do email e procura "evil.com".
    const bodyRes = await fetch(`http://localhost:8025/api/v1/message/${recent!.ID}`);
    const body = await bodyRes.json() as { Text?: string; HTML?: string };
    const fullBody = (body.Text ?? "") + " " + (body.HTML ?? "");
    assertEquals(
      fullBody.includes("evil.com"),
      false,
      "email contém domínio evil.com - phishing-via-header NÃO foi bloqueado",
    );
    // Sanity: o link tem de apontar para o panel allowlistado (localhost:3400 em dev).
    assertEquals(
      fullBody.includes("localhost:3400") || fullBody.includes("painel.mague.pt"),
      true,
      "email não tem link para o panel legítimo",
    );
  });

  it("attack: origin allowlistado com aspas no path NÃO injeta link no email", async () => {
    // O helper devolvia o header inteiro e o template não escapava o href:
    // a aspa fechava o atributo e o botão passava a apontar para fora.
    const res = await fetch(`${BASE_URL}/v1/auth/forgot-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Panel-Base-URL": 'http://localhost:3400/"></a><a href="https://evil.example/c?x=',
      },
      body: JSON.stringify({ identifier: victimEmail }),
    });
    assertEquals(res.status === 200 || res.status === 204, true);
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 300));

    const mp = await fetch(`http://localhost:8025/api/v1/messages?limit=5`);
    const list = await mp.json() as {
      messages: Array<{ ID: string; To: Array<{ Address: string }>; Subject: string }>;
    };
    const recent = list.messages.find((m) =>
      m.To.some((t) => t.Address === victimEmail) && m.Subject.includes("Reset")
    );
    assertNotEquals(recent, undefined, "email de reset não chegou ao mailpit");
    const bodyRes = await fetch(`http://localhost:8025/api/v1/message/${recent!.ID}`);
    const body = await bodyRes.json() as { Text?: string; HTML?: string };
    const fullBody = (body.Text ?? "") + " " + (body.HTML ?? "");
    assertEquals(fullBody.includes("evil.example"), false, "link injetado no email de reset");
    assertEquals(fullBody.includes("http://localhost:3400/reset-password?token="), true);
  });

  it("cleanup", async () => {
    try {
      await sql`DELETE FROM core.user WHERE id = ${victimUserId}`;
    } finally {
      await sql.end();
    }
  });
});
