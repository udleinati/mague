// E2E: apagar um condomínio (soft-delete do super) corta o acesso de quem lá
// estava. Antes, a vinculação ignorava `condominium.deleted_at`: ocupantes
// continuavam a ler/escrever no portal e managers no admin.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAs, loginAsSuper } from "./_helpers/auth.ts";
import { seedTestUser, sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

async function status(path: string, headers: Record<string, string>): Promise<number> {
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  await res.body?.cancel();
  return res.status;
}

describe("security - condomínio apagado corta portal e admin", () => {
  let condo: Condominium;
  let unit: Unit;
  let occupantHeaders: { Authorization: string };
  let managerHeaders: { Authorization: string };

  it("setup: condo + fração + ocupante + manager", async () => {
    const ts = Date.now();
    condo = (await client.super.createCondominium(
      { name: `Deleted Condo Access ${ts}` },
      { headers: MASTER },
    )).data;
    unit = (await client.super.createUnit(
      condo.id,
      { designation: "A1", permillage: 1000 },
      { headers: MASTER },
    )).data;

    const occEmail = `occ-deleted-condo-${ts}@example.pt`;
    const occUid = await seedTestUser({ email: occEmail, password: "test12345" });
    const occId = (await sqlExec(`
      INSERT INTO core.occupant (user_id,name,email,condominium_id)
      VALUES ('${occUid}','Occ','${occEmail}','${condo.id}')
      RETURNING id`)).split("\n")[0].trim();
    await sqlExec(`
      INSERT INTO core.unit_occupant (unit_id,occupant_id,relationship_type,start_date)
      VALUES ('${unit.id}','${occId}','owner',CURRENT_DATE);
    `);
    occupantHeaders = await loginAs(occEmail, "test12345");

    const mgrEmail = `mgr-deleted-condo-${ts}@example.pt`;
    const mgrUid = await seedTestUser({ email: mgrEmail, password: "test12345" });
    await sqlExec(`
      INSERT INTO core.manager (condominium_id,user_id) VALUES ('${condo.id}','${mgrUid}');
    `);
    managerHeaders = await loginAs(mgrEmail, "test12345");

    const portalUnit = `/v1/portal/condominiums/${condo.id}/units/${unit.id}`;
    assertEquals(await status(portalUnit, occupantHeaders), 200);
    assertEquals(await status(`/v1/admin/condominiums/${condo.id}/units`, managerHeaders), 200);
  });

  it("depois do delete: portal e admin deixam de responder ao ex-vinculado", async () => {
    await client.super.deleteCondominium(condo.id, { headers: MASTER });

    const portal = `/v1/portal/condominiums/${condo.id}`;
    for (
      const path of [
        `${portal}/units/${unit.id}`,
        `${portal}/units/${unit.id}/charges`,
        `${portal}/units/${unit.id}/tickets`,
        `${portal}/documents`,
      ]
    ) {
      assertEquals(await status(path, occupantHeaders), 403, path);
    }
    assertEquals(await status(`/v1/admin/condominiums/${condo.id}/units`, managerHeaders), 403);
  });
});
