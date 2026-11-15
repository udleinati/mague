// POST /admin/c/:cid/occupants/:occupantId/invite no painel: o id não muda de condomínio.
//
// A rota montava o URL da API à mão com o occupantId descodificado. Com
// "..%2F..%2FB%2Foccupants%2F<id>" o fetch normalizava o path para o condomínio B e o
// convite de B saía a partir do ecrã de A, fora do gate que validou A.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { deleteTestUser, seedTestUser, sqlExec } from "./_helpers/db.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const API_URL = "http://localhost:3000";
const PANEL_URL = "http://localhost:3400";
const client = new Client({ baseUrl: API_URL });

async function loginPanelAs(email: string, password: string): Promise<string> {
  const resp = await fetch(`${PANEL_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ identifier: email, password }).toString(),
    redirect: "manual",
  });
  await resp.body?.cancel();
  if (resp.status !== 302) throw new Error(`Login panel falhou (HTTP ${resp.status})`);
  const m = (resp.headers.get("set-cookie") ?? "").match(/token=([^;]+)/);
  if (!m) throw new Error("Cookie 'token' em falta");
  return m[1];
}

describe("panel: convite de ocupante com ../ no id", () => {
  const stamp = Date.now();
  const email = `invite-path-${stamp}@example.pt`;
  let A: ScenarioFixture;
  let B: ScenarioFixture;
  let managerId = "";

  const occupantUserId = () =>
    sqlExec(`SELECT COALESCE(user_id, '') FROM core.occupant WHERE id='${B.occupants[0].id}'`);

  it("setup: gestor de A e de B, ocupante de B por convidar", async () => {
    const auth = await loginAsSuper();
    A = await seedScenario(client, auth).withCondo(`Invite Path A ${stamp}`).build();
    B = await seedScenario(client, auth)
      .withCondo(`Invite Path B ${stamp}`)
      .withUnit({ designation: "B1" })
      .withOccupant({
        name: `Ocupante B ${stamp}`,
        email: `invite-path-occ-${stamp}@example.pt`,
        unitDesignation: "B1",
      })
      .build();
    managerId = await seedTestUser({ email, password: "test12345" });
    await sqlExec(
      `INSERT INTO core.manager (condominium_id, user_id) VALUES
         ('${A.condominium.id}', '${managerId}'), ('${B.condominium.id}', '${managerId}')`,
    );
  });

  it("o convite de B não sai pelo path de A", async () => {
    const token = await loginPanelAs(email, "test12345");
    const crafted = `..%2F..%2F${B.condominium.id}%2Foccupants%2F${B.occupants[0].id}`;
    const url = `${PANEL_URL}/admin/c/${A.condominium.id}/occupants/${crafted}/invite`;
    for (const htmx of [true, false]) {
      const resp = await fetch(url, {
        method: "POST",
        headers: { Cookie: `token=${token}`, ...(htmx ? { "HX-Request": "true" } : {}) },
        redirect: "manual",
      });
      await resp.body?.cancel();
      assertEquals(await occupantUserId(), "", `convite de B emitido (htmx=${htmx})`);
    }

    // Controlo: no próprio B o convite sai e liga a conta.
    const resp = await fetch(
      `${PANEL_URL}/admin/c/${B.condominium.id}/occupants/${B.occupants[0].id}/invite`,
      { method: "POST", headers: { Cookie: `token=${token}` }, redirect: "manual" },
    );
    await resp.body?.cancel();
    assertEquals((await occupantUserId()) !== "", true);
  });

  it("teardown", async () => {
    const invited = await occupantUserId();
    await sqlExec(`DELETE FROM core.manager WHERE user_id='${managerId}'`);
    await sqlExec(`UPDATE core.occupant SET user_id=NULL WHERE id='${B.occupants[0].id}'`);
    if (invited) await deleteTestUser(invited);
    await deleteTestUser(managerId);
    await A.cleanup();
    await B.cleanup();
  });
});
