// E2E: POST /v1/auth/me/theme - persistência da preferência de tema em
// `core.user.theme`.
//
// Cobre:
//   1. Sem auth → 401.
//   2. Body inválido (não é 'light'/'dark') → null guardado, ou 400 se vazio.
//   3. Sequence light → dark → null funciona e reflete no /auth/me.
//   4. Persistência sobrevive a logout/login (vem da DB, não de cache).

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import postgresjs from "postgresjs";
import bcrypt from "npm:bcryptjs@2.4.3";
import { Client } from "$shared/client/mod.ts";

const BASE_URL = "http://localhost:3000";
const DATABASE_URL = Deno.env.get("DATABASE_URL") ??
  "postgres://mague:mague@localhost:5432/mague";
const client = new Client({ baseUrl: BASE_URL });
const sql = postgresjs(DATABASE_URL, { max: 2 });

describe("auth - save theme", () => {
  const runStamp = Date.now();
  const userEmail = `auth-theme-${runStamp}@test.pt`;
  const userPassword = "TestPass1234";
  let userId = "";
  let token = "";

  it("setup - cria user e login", async () => {
    const hash = await bcrypt.hash(userPassword, 10);
    const created = await sql<{ id: string }[]>`
      INSERT INTO core.user (name, email, role, is_active, password_hash)
      VALUES ('Theme User', ${userEmail.toLowerCase()}, NULL, true, ${hash})
      RETURNING id
    `;
    userId = created[0].id;

    const { data } = await client.auth.login(userEmail, userPassword);
    token = data.token;
    // Theme inicial é null (default).
    assertEquals(data.user.theme ?? null, null);
  });

  it("401 sem token", async () => {
    const res = await fetch(`${BASE_URL}/v1/auth/me/theme`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: "dark" }),
    });
    assertEquals(res.status, 401);
    await res.body?.cancel();
  });

  it("guarda 'dark' e persiste em DB", async () => {
    const { data, status } = await client.auth.saveTheme(token, "dark");
    assertEquals(status, 200);
    assertEquals(data.theme, "dark");

    const row = await sql<{ theme: string | null }[]>`
      SELECT theme FROM core.user WHERE id = ${userId}
    `;
    assertEquals(row[0].theme, "dark");
  });

  it("/auth/me reflete o valor guardado", async () => {
    const { data } = await client.auth.me(token);
    assertEquals(data.user.theme, "dark");
  });

  it("muda para 'light'", async () => {
    const { data } = await client.auth.saveTheme(token, "light");
    assertEquals(data.theme, "light");

    const row = await sql<{ theme: string | null }[]>`
      SELECT theme FROM core.user WHERE id = ${userId}
    `;
    assertEquals(row[0].theme, "light");
  });

  it("null limpa a preferência", async () => {
    const { data } = await client.auth.saveTheme(token, null);
    assertEquals(data.theme, null);

    const row = await sql<{ theme: string | null }[]>`
      SELECT theme FROM core.user WHERE id = ${userId}
    `;
    assertEquals(row[0].theme, null);
  });

  it("valor inválido vira null (sanitização defensiva)", async () => {
    const res = await fetch(`${BASE_URL}/v1/auth/me/theme`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ theme: "blue" }),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.theme, null);
  });

  it("persiste após novo login (vem da DB, não de cache de sessão)", async () => {
    // Grava dark, depois faz NOVO login e confirma que /auth/me ainda traz dark.
    await client.auth.saveTheme(token, "dark");
    const { data: session } = await client.auth.login(userEmail, userPassword);
    assertEquals(session.user.theme, "dark");
    const { data: me } = await client.auth.me(session.token);
    assertEquals(me.user.theme, "dark");
  });

  it("cleanup", async () => {
    try {
      await sql`DELETE FROM core.user WHERE id = ${userId}`;
    } finally {
      await sql.end();
    }
  });
});
