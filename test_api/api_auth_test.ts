import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client } from "$shared/client/mod.ts";

// Auth flow: login → /auth/me → logout.
// /auth/login devolve JWT (token). Usado em `Authorization: Bearer <token>`.
// JWT Bearer é o único caminho suportado - os headers `x-role: master` e
// `x-session-id` não são aceites.

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
// Password do super seedado. Default "test" (seed `deno task seed`);
// override via env `SUPER_PASSWORD` quando o DB local tem outra
// password (alinha com `_helpers/auth.ts`).
const SUPER_PASSWORD = Deno.env.get("SUPER_PASSWORD") ?? "test";

describe("auth", () => {
  let token = "";

  it("login - credenciais inválidas retorna 401", async () => {
    const e = await assertRejects(
      () => client.auth.login("super@mague.pt", "wrong-password"),
      ApiError,
    );
    assertEquals(e.statusCode, 401);
  });

  it("login - valid super credentials return 200 + JWT token", async () => {
    const { data, status } = await client.auth.login("super@mague.pt", SUPER_PASSWORD);
    assertEquals(status, 200);
    assertEquals(typeof data.token, "string");
    // JWT tem formato header.payload.signature.
    assertEquals(data.token.split(".").length, 3);
    assertEquals(data.user.email, "super@mague.pt");
    assertEquals(data.user.role, "super");
    token = data.token;
  });

  it("me - with valid JWT token (Authorization Bearer) returns user", async () => {
    const { data, status } = await client.auth.me(token);
    assertEquals(status, 200);
    assertEquals(data.user.email, "super@mague.pt");
    assertEquals(Array.isArray(data.managedCondominiumIds), true);
  });

  it("me - with invalid token returns 401", async () => {
    const e = await assertRejects(
      () => client.auth.me("invalid.token.here"),
      ApiError,
    );
    assertEquals(e.statusCode, 401);
  });

  it("me - without token returns 401", async () => {
    const e = await assertRejects(
      () => client.auth.me(""),
      ApiError,
    );
    assertEquals(e.statusCode, 401);
  });

  it("admin endpoint - Authorization Bearer authorises access", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const { data: condo } = await client.super.createCondominium(
      { name: "Auth Test Condo" },
      { headers: auth },
    );
    try {
      const { status } = await client.admin.listUnits({
        headers: { ...auth, "x-condominium-id": condo.id },
      });
      assertEquals(status, 200);
    } finally {
      await client.super.deleteCondominium(condo.id, { headers: auth });
    }
  });

  it("x-role: master não é aceite - devolve 401", async () => {
    const res = await fetch(`${BASE_URL}/v1/super/condominiums`, {
      method: "GET",
      headers: { "x-role": "master" },
    });
    assertEquals(res.status, 401);
    await res.body?.cancel();
  });

  it("x-session-id não é aceite - devolve 401", async () => {
    const res = await fetch(`${BASE_URL}/v1/super/condominiums`, {
      method: "GET",
      headers: { "x-session-id": "doesNotMatter_legacy_never_parsed" },
    });
    assertEquals(res.status, 401);
    await res.body?.cancel();
  });

  it("logout - invalida a sessão", async () => {
    const { status } = await client.auth.logout(token);
    assertEquals(status, 200);
    // Após logout, /auth/me com o mesmo token devolve 401.
    const e = await assertRejects(() => client.auth.me(token), ApiError);
    assertEquals(e.statusCode, 401);
  });
});
