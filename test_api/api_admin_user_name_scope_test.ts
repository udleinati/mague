// PATCH /v1/admin/condominiums/:cid/users/:userId - quem pode mudar o nome da conta.
//
// O nome é da conta, e a conta serve todos os condomínios da pessoa. O admin de A
// que muda o nome de alguém que também está em B muda-o no ecrã de B. Mesma regra
// do reset e do convite: uma conta que abre outro condomínio (ou é super) só é
// renomeada por um super.
//   1. Conta que também gere B → 403, nome intacto.
//   2. Conta condómina em B → 403.
//   3. Conta super → 403.
//   4. Sem mudar o nome (o formulário reenvia-o sempre), o toggle de admin continua.
//   5. Controlos: conta só de A renomeia-se; o super renomeia a conta partilhada.

import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client, type Condominium } from "$shared/client/mod.ts";
import { loginAs, loginAsSuper } from "./_helpers/auth.ts";
import { deleteTestUser, seedTestUser, sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });
const PASSWORD = "test12345";

const nameOf = (id: string) => sqlExec(`SELECT name FROM core."user" WHERE id='${id}'`);

describe("admin user - nome de conta partilhada", () => {
  const stamp = Date.now();
  let condoA: Condominium;
  let condoB: Condominium;
  let adminA: Record<string, string>;
  let superA: Record<string, string>;
  const ids: Record<string, string> = {};

  it("setup", async () => {
    condoA = (await client.super.createCondominium(
      { name: `Nome A ${stamp}`, fiscalNumber: "509400501" },
      { headers: AUTH },
    )).data;
    condoB = (await client.super.createCondominium(
      { name: `Nome B ${stamp}`, fiscalNumber: "509400502" },
      { headers: AUTH },
    )).data;
    superA = { ...AUTH, "x-condominium-id": condoA.id };

    for (const key of ["admin", "onlyA", "managesB", "ownsInB", "super"]) {
      ids[key] = await seedTestUser({
        email: `name-scope-${key.toLowerCase()}-${stamp}@example.pt`,
        name: `Original ${key}`,
        password: PASSWORD,
        role: key === "super" ? "super" : null,
      });
    }
    // Todas visíveis ao admin de A (manager em A); algumas também chegam a B.
    await sqlExec(
      `INSERT INTO core.manager (condominium_id, user_id) VALUES
         ${
        Object.values(ids).map((id) => `('${condoA.id}', '${id}')`).join(", ")
      }, ('${condoB.id}', '${ids.managesB}')`,
    );
    await sqlExec(
      `INSERT INTO core.occupant (condominium_id, user_id, name)
       VALUES ('${condoB.id}', '${ids.ownsInB}', 'Condómina em B')`,
    );
    adminA = {
      ...(await loginAs(`name-scope-admin-${stamp}@example.pt`, PASSWORD)),
      "x-condominium-id": condoA.id,
    };
  });

  it("admin de A não muda o nome de contas que chegam a outro condomínio", async () => {
    // WHY: o nome mudava também nas listagens e emails de B, que o admin de A não gere.
    for (const key of ["managesB", "ownsInB", "super"]) {
      const e = await assertRejects(
        () => client.admin.updateUser(ids[key], { name: "Renomeado por A" }, { headers: adminA }),
        ApiError,
      );
      assertEquals(e.statusCode, 403, key);
      assertEquals(await nameOf(ids[key]), `Original ${key}`, key);
    }
  });

  it("o formulário reenvia o nome igual: o toggle de admin continua a funcionar", async () => {
    // O edit do painel manda sempre o name; bloquear só por vir no corpo partia o toggle.
    const { status } = await client.admin.updateUser(
      ids.managesB,
      { name: "Original managesB", isManager: true },
      { headers: adminA },
    );
    assertEquals(status, 200);
  });

  it("controlo: conta só de A renomeia-se; o super renomeia a partilhada", async () => {
    await client.admin.updateUser(ids.onlyA, { name: "Só A renomeada" }, { headers: adminA });
    assertEquals(await nameOf(ids.onlyA), "Só A renomeada");
    await client.admin.updateUser(ids.managesB, { name: "Pelo super" }, { headers: superA });
    assertEquals(await nameOf(ids.managesB), "Pelo super");
  });

  it("teardown", async () => {
    await sqlExec(`DELETE FROM core.occupant WHERE user_id='${ids.ownsInB}'`);
    for (const id of Object.values(ids)) {
      await sqlExec(`DELETE FROM core.manager WHERE user_id='${id}'`);
      await deleteTestUser(id);
    }
  });
});
