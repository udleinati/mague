// Integration test: manager do condomínio pode entrar no portal como
// qualquer fração desse condo (impersonate admin), sem ser owner.
//
// O gate IDOR do portal (panel/main.ts) faz bypass para role==="super" e para
// `managedCondominiumIds.includes(cid)`. Sem o segundo, o manager seria tratado
// como occupant comum → 404 "Fração não acessível" + redirect para
// /privacy-notice.
//
// Anti-regressão: se alguém estreitar o gate, este teste apanha.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { sqlExec } from "./_helpers/db.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const API_URL = "http://localhost:3000";
const PANEL_URL = "http://localhost:3400";

const client = new Client({ baseUrl: API_URL });

async function loginPanelAs(email: string, password: string): Promise<string> {
  const fd = new URLSearchParams({ identifier: email, password });
  const resp = await fetch(`${PANEL_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: fd.toString(),
    redirect: "manual",
  });
  await resp.body?.cancel();
  if (resp.status !== 302) {
    throw new Error(`Login panel falhou (HTTP ${resp.status}) para ${email}`);
  }
  const setCookie = resp.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/token=([^;]+)/);
  if (!m) throw new Error(`Cookie 'token' em falta: ${setCookie}`);
  return m[1];
}

describe("panel impersonate - manager do condo (não super, não owner)", () => {
  let auth: { Authorization: string };
  let fx: ScenarioFixture;
  let unitId = "";
  // bcrypt hash de "test" (mesmo usado pelo super, cf. login.ts).
  const managerEmail = `manager-impersonate-${crypto.randomUUID().slice(0, 8)}@test.pt`;
  const managerPasswordHash = "$2a$10$wdo4Z31Hw4BL/DmHEyU9aexRSt0wTxozUKuhBPMBAoYkLctnXz9v.";
  let managerUserId = "";

  it("setup: condo + unit + user manager (NÃO super, NÃO owner da unit)", async () => {
    auth = await loginAsSuper();
    fx = await seedScenario(client, auth)
      .withCondo("Impersonate Manager E2E")
      .withUnit({ designation: "A1", permillage: 1000 })
      .build();
    unitId = fx.units[0].id;

    // Cria user via SQL: role=null (não super), password "test", manager
    // só deste condo. Sem unit_occupant - este user NÃO é owner.
    managerUserId = (await sqlExec(`
      INSERT INTO core."user" (id, email, password_hash, role, is_active, name)
      VALUES (
        'u_imp_mgr_' || substr(md5(random()::text), 1, 6),
        '${managerEmail}',
        '${managerPasswordHash}',
        NULL,
        TRUE,
        'Manager Impersonate'
      ) RETURNING id`)).split("\n")[0].trim();

    await sqlExec(`
      INSERT INTO core.manager (condominium_id, user_id, is_active)
      VALUES ('${fx.condominium.id}', '${managerUserId}', TRUE);
    `);
  });

  it("manager faz GET /portal/c/:cid/u/:uid → 200 (não 404 nem redirect privacy)", async () => {
    const token = await loginPanelAs(managerEmail, "test");
    const resp = await fetch(`${PANEL_URL}/portal/c/${fx.condominium.id}/u/${unitId}`, {
      headers: { Cookie: `token=${token}` },
      redirect: "manual",
    });
    await resp.body?.cancel();
    // 200 com a página do portal renderizada (não 404 nem 302 → /privacy-notice).
    assertEquals(resp.status, 200);
  });

  it("teardown", async () => {
    await sqlExec(`DELETE FROM core.manager WHERE user_id = '${managerUserId}';`);
    await sqlExec(`DELETE FROM core."user" WHERE id = '${managerUserId}';`);
    await fx.cleanup();
  });
});
