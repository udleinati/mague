// Gate do portal no painel: a fração do path tem de pertencer ao cid do path.
//
// O gate só procurava o unitId em occupantUnits. Um condómino de A abria
// /portal/c/B/u/<fração de A> com o cid B no ALS, e os proxies de download a nível
// de condomínio pediam à API os documentos de B em nome dele. Hoje a API trava-o,
// mas o painel não deve depender disso.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client } from "$shared/client/mod.ts";
import { loginAs, loginAsSuper } from "./_helpers/auth.ts";
import { deleteTestUser, seedTestUser, sqlExec, sqlExecBeforeTenantGuard } from "./_helpers/db.ts";
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

describe("panel portal: fração de A pedida com o cid de B", () => {
  const stamp = Date.now();
  const email = `gate-portal-${stamp}@example.pt`;
  let A: ScenarioFixture;
  let B: ScenarioFixture;
  let userId = "";
  let strayOccupantId = "";

  it("setup: condómino de A1, sem nada em B", async () => {
    const auth = await loginAsSuper();
    A = await seedScenario(client, auth)
      .withCondo(`Gate Portal A ${stamp}`)
      .withUnit({ designation: "A1" })
      .withOccupant({ name: `Dona A ${stamp}`, email, unitDesignation: "A1" })
      .build();
    B = await seedScenario(client, auth)
      .withCondo(`Gate Portal B ${stamp}`)
      .withUnit({ designation: "B1" })
      .build();
    userId = await seedTestUser({ email, password: "test12345" });
    await sqlExec(`UPDATE core."user" SET terms_acknowledged_at = now() WHERE id='${userId}'`);
    await sqlExec(`UPDATE core.occupant SET user_id='${userId}' WHERE id='${A.occupants[0].id}'`);
  });

  it("controlo: a própria fração abre no condomínio dela", async () => {
    const token = await loginPanelAs(email, "test12345");
    const resp = await fetch(`${PANEL_URL}/portal/c/${A.condominium.id}/u/${A.units[0].id}`, {
      headers: { Cookie: `token=${token}` },
      redirect: "manual",
    });
    await resp.body?.cancel();
    assertEquals(resp.status, 200);
  });

  it("a mesma fração com o cid de B pára no gate do painel", async () => {
    const token = await loginPanelAs(email, "test12345");
    const resp = await fetch(`${PANEL_URL}/portal/c/${B.condominium.id}/u/${A.units[0].id}`, {
      headers: { Cookie: `token=${token}` },
      redirect: "manual",
    });
    // Sem o gate, o 404 vinha da API ("Página não encontrada"), já dentro do handler.
    assertEquals(resp.status, 404);
    assertStringIncludes(await resp.text(), "Fração não acessível");
  });

  it("o gate lê o path como o router: /%75/ não esconde a fração", async () => {
    // O gate classificava o path cru e não via /u/<uid>; o Hono descodifica %75 para "u"
    // e servia a rota da fração com o cid de B no contexto, sem validar a fração.
    const token = await loginPanelAs(email, "test12345");
    const resp = await fetch(`${PANEL_URL}/portal/c/${B.condominium.id}/%75/${A.units[0].id}`, {
      headers: { Cookie: `token=${token}` },
      redirect: "manual",
    });
    assertEquals(resp.status, 404);
    assertStringIncludes(await resp.text(), "Fração não acessível");
  });

  it("/set-nif só aceita frações do próprio, com o cid delas", async () => {
    // A rota está fora do gate do portal e lê cid e unitId do form.
    const token = await loginPanelAs(email, "test12345");
    const post = async (cid: string, unitId: string) => {
      const resp = await fetch(`${PANEL_URL}/set-nif`, {
        method: "POST",
        headers: {
          Cookie: `token=${token}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: `${PANEL_URL}/portal/c/${A.condominium.id}/u/${A.units[0].id}`,
        },
        body: new URLSearchParams({ nif: "245678905", cid, unitId }).toString(),
        redirect: "manual",
      });
      await resp.body?.cancel();
      return new URL(resp.headers.get("location") ?? "/", PANEL_URL).searchParams.get("flash");
    };
    assertEquals(await post(B.condominium.id, A.units[0].id), "Fração não acessível.");
    assertEquals(await post(A.condominium.id, B.units[0].id), "Fração não acessível.");
    assertEquals(await post(A.condominium.id, A.units[0].id), "NIF guardado.");
  });

  it("/auth/me ignora a ligação de um occupant de B a uma fração de A", async () => {
    // Uma ligação cruzada gravada antes dos guards punha A1 no seletor com o occupant de B.
    strayOccupantId = (await sqlExec(
      `INSERT INTO core.occupant (condominium_id, name, email, user_id)
       VALUES ('${B.condominium.id}', 'Occupant B cruzado', '${email}', '${userId}') RETURNING id`,
    )).split("\n")[0].trim();
    await sqlExecBeforeTenantGuard(
      "core.unit_occupant",
      `INSERT INTO core.unit_occupant (unit_id, occupant_id, relationship_type, start_date)
       VALUES ('${A.units[0].id}', '${strayOccupantId}', 'owner', '2025-01-01')`,
    );

    const auth = await loginAs(email, "test12345");
    const token = auth.Authorization.replace("Bearer ", "");
    const { data: me } = await client.auth.me(token);
    const units = me.occupantUnits ?? [];
    assert(units.some((u) => u.occupantId === A.occupants[0].id), "a ligação de A mantém-se");
    assertEquals(units.filter((u) => u.occupantId === strayOccupantId), []);
  });

  it("teardown", async () => {
    if (strayOccupantId) {
      await sqlExec(`DELETE FROM core.unit_occupant WHERE occupant_id='${strayOccupantId}'`);
      await sqlExec(`DELETE FROM core.occupant WHERE id='${strayOccupantId}'`);
    }
    await sqlExec(`UPDATE core.occupant SET user_id=NULL WHERE id='${A.occupants[0].id}'`);
    await deleteTestUser(userId);
    await A.cleanup();
    await B.cleanup();
  });
});
