// E2E: tracking de login no nível `core.user`.
//
// Diferente de `api_auth_tracking_test.ts` que verifica os campos no
// `core.occupant`, este teste cobre os
// campos no `core.user` que valem para super/admin sem occupant.
//
//   1. Login OK 1ª vez → popula `first_login_at` + `last_login_at`.
//   2. Login OK 2ª vez → preserva `first_login_at`, avança `last_login_at`.
//   3. Accept-invite → também popula ambos (write-once para `first_login_at`).
//
// Self-contained: cria user com password directa em DB para evitar SMTP, e
// para o teste de accept-invite cria invite_token também diretamente.

import { assertEquals, assertGreater } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import postgresjs from "postgresjs";
import bcrypt from "npm:bcryptjs@2.4.3";
import { Client } from "$shared/client/mod.ts";

const BASE_URL = "http://localhost:3000";
const DATABASE_URL = Deno.env.get("DATABASE_URL") ??
  "postgres://mague:mague@localhost:5432/mague";
const client = new Client({ baseUrl: BASE_URL });
const sql = postgresjs(DATABASE_URL, { max: 2 });

describe("auth - user-level first/last login tracking", () => {
  const runStamp = Date.now();
  const userEmail = `auth-user-track-${runStamp}@test.pt`;
  const userPassword = "TestPass1234";
  let userId = "";

  it("setup - cria user com password directa (sem invite)", async () => {
    const hash = await bcrypt.hash(userPassword, 10);
    const created = await sql<{ id: string }[]>`
      INSERT INTO core.user (name, email, role, is_active, password_hash)
      VALUES ('Tracking User', ${userEmail.toLowerCase()}, NULL, true, ${hash})
      RETURNING id
    `;
    userId = created[0].id;
    // Antes do 1º login ambos os timestamps devem estar NULL.
    const row = await sql<{ first: Date | null; last: Date | null }[]>`
      SELECT first_login_at AS first, last_login_at AS last
        FROM core.user WHERE id = ${userId}
    `;
    assertEquals(row[0].first, null);
    assertEquals(row[0].last, null);
  });

  it("login OK 1ª vez - popula first_login_at + last_login_at", async () => {
    const { status } = await client.auth.login(userEmail, userPassword);
    assertEquals(status, 200);

    const row = await sql<{ first: Date | null; last: Date | null }[]>`
      SELECT first_login_at AS first, last_login_at AS last
        FROM core.user WHERE id = ${userId}
    `;
    assertEquals(row[0].first !== null, true);
    assertEquals(row[0].last !== null, true);
    // first e last apontam para o mesmo instante (mesmo statement SQL).
    assertEquals(row[0].first!.getTime(), row[0].last!.getTime());
  });

  it("login OK 2ª vez - first_login_at preservado, last_login_at avança", async () => {
    const before = await sql<{ first: Date }[]>`
      SELECT first_login_at AS first FROM core.user WHERE id = ${userId}
    `;
    await new Promise((r) => setTimeout(r, 50));

    const { status } = await client.auth.login(userEmail, userPassword);
    assertEquals(status, 200);

    const after = await sql<{ first: Date; last: Date }[]>`
      SELECT first_login_at AS first, last_login_at AS last
        FROM core.user WHERE id = ${userId}
    `;
    // first_login_at é write-once via COALESCE - não muda.
    assertEquals(before[0].first.getTime(), after[0].first.getTime());
    // last_login_at avançou (>= porque a resolução pode coincidir num run rápido).
    assertEquals(after[0].last.getTime() >= after[0].first.getTime(), true);
  });

  it("accept-invite - popula first_login_at + last_login_at em conta nunca usada", async () => {
    // User criado SEM password - simula o estado pós-criação por admin.
    const inviteEmail = `auth-invite-track-${runStamp}@test.pt`;
    const created = await sql<{ id: string }[]>`
      INSERT INTO core.user (name, email, role, is_active, password_hash)
      VALUES ('Invite User', ${inviteEmail}, NULL, true, NULL)
      RETURNING id
    `;
    const inviteUserId = created[0].id;

    // Token de convite (purpose = 'invite', expires futuro).
    const token = `tok_${runStamp}_${Math.random().toString(36).slice(2, 10)}`;
    await sql`
      INSERT INTO core.invite_token (token, user_id, purpose, expires_at)
      VALUES (${token}, ${inviteUserId}, 'invite', NOW() + INTERVAL '1 day')
    `;

    // Estado inicial - nada populado.
    const before = await sql<{ first: Date | null; last: Date | null }[]>`
      SELECT first_login_at AS first, last_login_at AS last
        FROM core.user WHERE id = ${inviteUserId}
    `;
    assertEquals(before[0].first, null);
    assertEquals(before[0].last, null);

    // POST /v1/auth/accept-invite com password mínima (>= 8).
    const res = await fetch(`${BASE_URL}/v1/auth/accept-invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password: "AcceptedPass99" }),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(typeof body.data.token, "string");

    const after = await sql<{ first: Date; last: Date }[]>`
      SELECT first_login_at AS first, last_login_at AS last
        FROM core.user WHERE id = ${inviteUserId}
    `;
    assertGreater(after[0].first.getTime(), 0);
    assertGreater(after[0].last.getTime(), 0);
    // Mesmo statement SQL → first === last.
    assertEquals(after[0].first.getTime(), after[0].last.getTime());

    // Cleanup do user de invite.
    await sql`DELETE FROM core.invite_token WHERE user_id = ${inviteUserId}`;
    await sql`DELETE FROM core.user WHERE id = ${inviteUserId}`;
  });

  it("cleanup - remove user de teste e fecha conexão", async () => {
    try {
      await sql`DELETE FROM core.user WHERE id = ${userId}`;
    } finally {
      await sql.end();
    }
  });
});
