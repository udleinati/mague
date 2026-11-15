// POST /v1/admin/condominiums/:cid/occupants/:occId/invite - a quem pode um admin
// mandar um convite.
//
// O convite liga o ocupante a uma conta (a do userId ou a do mesmo email) e aceitá-lo
// define a password dessa conta. O link fica no registo de emails do condomínio e no
// BCC, que o admin lê. Por isso segue a regra do reset assistido: uma conta que abre
// outro condomínio (ou é super) só é convidada por um super.
//   1. Conta que gere B, pelo email, em A → 403, sem token nem ligação.
//   2. Conta super, pelo email, em A → 403.
//   3. userId no corpo do ocupante é ignorado (criar e editar).
//   4. Controlos: email novo e conta só de A continuam a convidar; o super convida.

import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client, type Condominium } from "$shared/client/mod.ts";
import { loginAs, loginAsSuper } from "./_helpers/auth.ts";
import { deleteTestUser, seedTestUser, sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });
const PASSWORD = "test12345";

async function openInviteTokens(userId: string): Promise<number> {
  return Number(
    await sqlExec(
      `SELECT COUNT(*) FROM core.invite_token WHERE user_id='${userId}' AND used_at IS NULL`,
    ),
  );
}

async function occupantUserId(occupantId: string): Promise<string> {
  return await sqlExec(`SELECT COALESCE(user_id, '') FROM core.occupant WHERE id='${occupantId}'`);
}

describe("admin occupant - convite só a contas que quem convida gere", () => {
  const stamp = Date.now();
  let condoA: Condominium;
  let condoB: Condominium;
  let adminA: Record<string, string>;
  let superA: Record<string, string>;
  const adminEmail = `inv-scope-admin-${stamp}@example.pt`;
  const managesBEmail = `inv-scope-manages-b-${stamp}@example.pt`;
  const superEmail = `inv-scope-super-${stamp}@example.pt`;
  const onlyAEmail = `inv-scope-only-a-${stamp}@example.pt`;
  let adminId = "";
  let managesBId = "";
  let superId = "";
  let onlyAId = "";

  it("setup", async () => {
    condoA = (await client.super.createCondominium(
      { name: `Convite A ${stamp}`, fiscalNumber: "509400401" },
      { headers: AUTH },
    )).data;
    condoB = (await client.super.createCondominium(
      { name: `Convite B ${stamp}`, fiscalNumber: "509400402" },
      { headers: AUTH },
    )).data;
    superA = { ...AUTH, "x-condominium-id": condoA.id };

    adminId = await seedTestUser({ email: adminEmail, password: PASSWORD });
    managesBId = await seedTestUser({ email: managesBEmail, password: PASSWORD });
    superId = await seedTestUser({ email: superEmail, password: PASSWORD, role: "super" });
    onlyAId = await seedTestUser({ email: onlyAEmail, password: PASSWORD });
    await sqlExec(
      `INSERT INTO core.manager (condominium_id, user_id) VALUES
         ('${condoA.id}', '${adminId}'), ('${condoB.id}', '${managesBId}')`,
    );
    await sqlExec(
      `INSERT INTO core.occupant (condominium_id, user_id, name)
       VALUES ('${condoA.id}', '${onlyAId}', 'Só em A')`,
    );
    adminA = { ...(await loginAs(adminEmail, PASSWORD)), "x-condominium-id": condoA.id };
  });

  it("admin de A não convida, pelo email, a conta de quem gere B", async () => {
    // WHY: o link do convite ficava no registo de emails de A. O admin de A abria-o,
    // definia a password e entrava como gestor de B.
    const { data: occ } = await client.admin.createOccupant(
      { name: "Gestor de B", email: managesBEmail },
      { headers: adminA },
    );
    const e = await assertRejects(
      () => client.admin.inviteOccupant(occ.id, { headers: adminA }),
      ApiError,
    );
    assertEquals(e.statusCode, 403);
    assertEquals(await openInviteTokens(managesBId), 0);
    assertEquals(await occupantUserId(occ.id), "", "a conta de B não fica ligada a A");
  });

  it("admin de A não convida um super", async () => {
    // WHY: a conta super gere todos os condomínios.
    const { data: occ } = await client.admin.createOccupant(
      { name: "Super", email: superEmail },
      { headers: adminA },
    );
    const e = await assertRejects(
      () => client.admin.inviteOccupant(occ.id, { headers: adminA }),
      ApiError,
    );
    assertEquals(e.statusCode, 403);
    assertEquals(await openInviteTokens(superId), 0);
  });

  it("userId no corpo do ocupante não liga a conta", async () => {
    // WHY: com o userId de outra conta e um email à escolha, o convite ia para o admin.
    const { data: occ } = await client.admin.createOccupant(
      { name: "Atacante", email: `inv-scope-evil-${stamp}@example.pt`, userId: managesBId },
      { headers: adminA },
    );
    assertEquals(await occupantUserId(occ.id), "");
    await client.admin.updateOccupant(occ.id, { userId: superId }, { headers: adminA });
    assertEquals(await occupantUserId(occ.id), "");
  });

  it("controlo: email novo e conta só de A continuam a receber convite", async () => {
    const { data: fresh } = await client.admin.createOccupant(
      { name: "Nova", email: `inv-scope-fresh-${stamp}@example.pt` },
      { headers: adminA },
    );
    assertEquals((await client.admin.inviteOccupant(fresh.id, { headers: adminA })).status, 201);

    const onlyAOcc = await sqlExec(
      `SELECT id FROM core.occupant WHERE user_id='${onlyAId}' AND condominium_id='${condoA.id}'`,
    );
    await sqlExec(`UPDATE core.occupant SET email='${onlyAEmail}' WHERE id='${onlyAOcc}'`);
    assertEquals((await client.admin.inviteOccupant(onlyAOcc, { headers: adminA })).status, 201);
    assertEquals(await openInviteTokens(onlyAId), 1);
  });

  it("controlo: o super convida a conta de quem gere B", async () => {
    const { data: occ } = await client.admin.createOccupant(
      { name: "Gestor de B via super", email: managesBEmail },
      { headers: superA },
    );
    assertEquals((await client.admin.inviteOccupant(occ.id, { headers: superA })).status, 201);
    assertEquals(await occupantUserId(occ.id), managesBId);
  });

  it("teardown", async () => {
    const ids = [adminId, managesBId, superId, onlyAId];
    const inList = ids.map((id) => `'${id}'`).join(",");
    await sqlExec(
      `DELETE FROM core.occupant WHERE condominium_id IN ('${condoA.id}', '${condoB.id}')`,
    );
    await sqlExec(`DELETE FROM core.manager WHERE user_id IN (${inList})`);
    for (const id of ids) await deleteTestUser(id);
    // Contas criadas pelos convites de controlo.
    await sqlExec(
      `DELETE FROM core.invite_token WHERE user_id IN (SELECT id FROM core."user" WHERE email LIKE 'inv-scope-%-${stamp}@example.pt')`,
    );
    await sqlExec(`DELETE FROM core."user" WHERE email LIKE 'inv-scope-%-${stamp}@example.pt'`);
  });
});
