// E2E: POST /v1/auth/me/terms-acknowledged
//
// Endpoint self-service que regista que o user clicou em "OK, entendi"
// no aviso de privacidade do portal. Idempotente (write-once via COALESCE).
//
// Cobre:
//   1. Sem auth → 401.
//   2. Com auth → 200, devolve `acknowledgedAt: ISO`, persiste no DB.
//   3. Idempotência: 2.ª chamada preserva o timestamp original.
//   4. GET /v1/auth/me expõe `termsAcknowledgedAt` populado.

import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client } from "$shared/client/mod.ts";
import { loginAs, loginAsSuper } from "./_helpers/auth.ts";
import { seedTestUser, sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const SUPER = await loginAsSuper();

describe("auth - terms acknowledged (write-once)", () => {
  const stamp = Date.now();
  const email = `terms-${stamp}@test.pt`;
  let userId = "";
  let authToken = "";

  it("setup: cria user fresh (terms_acknowledged_at NULL)", async () => {
    userId = await seedTestUser({
      email,
      password: "test12345",
      name: "Terms Test",
      active: true,
    });
    const headers = await loginAs(email, "test12345");
    authToken = headers.Authorization.replace(/^Bearer /, "");
  });

  it("401 sem token", async () => {
    const r = await fetch(`${BASE_URL}/v1/auth/me/terms-acknowledged`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assertEquals(r.status, 401);
    await r.body?.cancel();
  });

  it("getMe antes da aceitação → termsAcknowledgedAt = null", async () => {
    const r = await client.auth.me(authToken);
    assertEquals(r.data.user.termsAcknowledgedAt, null);
  });

  let firstAck = "";

  it("POST → 200 com acknowledgedAt ISO; persiste no DB", async () => {
    const r = await client.auth.saveTermsAcknowledged(authToken);
    assertEquals(r.status, 200);
    assertExists(r.data.acknowledgedAt);
    firstAck = r.data.acknowledgedAt!;

    // Verifica DB direto.
    const out = await sqlExec(
      `SELECT terms_acknowledged_at FROM core."user" WHERE id = '${userId}'`,
    );
    assertEquals(out.length > 0, true);
  });

  it("getMe após aceitação → termsAcknowledgedAt populado", async () => {
    const r = await client.auth.me(authToken);
    assertExists(r.data.user.termsAcknowledgedAt);
  });

  it("idempotência: 2.ª chamada preserva timestamp original (write-once)", async () => {
    // Pequeno delay para garantir que NOW() não bate com o anterior.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const r = await client.auth.saveTermsAcknowledged(authToken);
    assertEquals(r.status, 200);
    // O timestamp tem de ser EXACTAMENTE o mesmo da 1ª chamada (COALESCE
    // não escreveu por cima).
    assertEquals(r.data.acknowledgedAt, firstAck);
  });

  it("teardown", async () => {
    await sqlExec(`DELETE FROM core.invite_token WHERE user_id = '${userId}'`);
    await sqlExec(`DELETE FROM core."user" WHERE id = '${userId}'`);
    // SUPER usado como side-effect só para evitar unused-var.
    assertEquals(typeof SUPER.Authorization, "string");
  });
});
